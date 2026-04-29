# Self-Healing Runtime Loop

**Status:** proposed
**Last updated:** 2026-04-22

## Why

Running NanoClaw means occasionally hitting real production regressions
(today: stale agent-runner copies, undici `headersTimeout`, Ollama silently
returning raw markdown, Slack `msg_too_long`). Each one takes the same loop:
tail the log, paste a stack into Claude, diagnose, edit, rebuild, restart.
The whole motion is mechanical. Claude already has every tool needed to do
it; the missing pieces are the log watcher, the Slack approval gate, and the
restart+verify feedback loop.

Goal: a second process running alongside `nanoclaw` that watches for errors,
asks Claude to diagnose and propose a fix, posts it in Slack with action
buttons, and on approval applies the edit, rebuilds, restarts, and verifies.
Human-in-the-loop on every write.

## Non-goals

- **Not** autonomous. Nothing auto-applies. Every write requires a click.
- **Not** a general monitoring system. Latency dashboards, metrics, and
  uptime tracking live elsewhere (or don't exist — that's fine).
- **Not** a replacement for a real CI pipeline. Healer fixes live
  regressions; code review still happens when the day's fixes get squashed
  into a PR at end of week.
- **Not** a second Slack app. Reuses the NanoClaw bot. One channel
  (`#nanoclaw-ops` or similar) for alerts.
- **Not** Docker-in-Docker. The healer runs on the host, same as `nanoclaw`.

## Architecture

```
┌─────────────────────────────────────────┐
│  nanoclaw.service (existing)            │
│    └─ appends → logs/nanoclaw.log       │
│    └─ containers → groups/*/logs/*      │
└─────────────────────────────────────────┘
                   │
                   │  fs.watch / streaming tail
                   ▼
┌─────────────────────────────────────────┐
│  nanoclaw-healer.service (new)          │
│                                          │
│  ┌───────────────────────────────────┐  │
│  │ 1. log-tailer.ts                  │  │
│  │   watch files, emit error events  │  │
│  │   dedup on signature + cooldown   │  │
│  └─────────────┬─────────────────────┘  │
│                ▼                         │
│  ┌───────────────────────────────────┐  │
│  │ 2. diagnostician (Claude SDK)     │  │
│  │   read-only tools:                │  │
│  │     Read, Grep, Glob, Bash(ro)    │  │
│  │   input:  error, stack, context   │  │
│  │   output: {rootCause, fix, files, │  │
│  │            confidence}            │  │
│  └─────────────┬─────────────────────┘  │
│                ▼                         │
│  ┌───────────────────────────────────┐  │
│  │ 3. slack-notifier.ts              │  │
│  │   post Block Kit card to          │  │
│  │   #nanoclaw-ops with buttons      │  │
│  │   via existing bot                │  │
│  └─────────────┬─────────────────────┘  │
│                ▼ (user clicks)           │
│  ┌───────────────────────────────────┐  │
│  │ 4. executor (Claude SDK)          │  │
│  │   write tools: Edit, Write,       │  │
│  │     Bash(rw including restart)    │  │
│  │   git-stash before edits          │  │
│  │   npm run build                   │  │
│  │   systemctl --user restart nanoclaw│ │
│  │   tail logs for 60s               │  │
│  │   pass → keep / fail → auto-rollback│ │
│  └─────────────┬─────────────────────┘  │
│                ▼                         │
│  ┌───────────────────────────────────┐  │
│  │ 5. audit-log.ts                   │  │
│  │   append every incident + outcome │  │
│  │   to healing-incidents.sqlite     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Why a separate process

Two reasons:

1. If `nanoclaw` crashes completely, the healer must still be running so it
   can diagnose and restart it.
2. Blast-radius isolation. Healer has write access to the repo and can run
   `systemctl restart nanoclaw`. Keeping it out-of-process means a healer
   bug can't take down the main assistant.

Run as `nanoclaw-healer.service` under the same user, lingered, same
`Restart=always` pattern.

## Signal sources

Priority order (implement in this order):

1. **`logs/nanoclaw.log`** — pino output from the main process. Watch for
   `level: 50` (error), `level: 60` (fatal), or the string `Max retries
   exceeded`, `Container exited with code`, `unhandledRejection`.
2. **`groups/*/logs/container-*.log`** — per-container logs written by
   `container-runner.ts` on error exits. Already structured (Stderr section,
   Exit Code). Watch for new files appearing.
3. **`logs/nanoclaw.error.log`** — Bolt / socket-mode errors written
   directly by the Slack SDK.

Later:
4. **Sidecar errors** (transcription Python logs arriving via
   `[source: transcription]` lines).
5. **Transcription jobs with `status='failed'`** in SQLite.
6. **Slack WebSocket liveness.** `logs/nanoclaw.error.log` filling with
   `socket-mode: ... Failed to send a WebSocket message as the client is
   not ready` is a known pattern: Bolt's Socket Mode reconnect occasionally
   fails silently, leaving the process alive but deaf to inbound events
   (observed 2026-04-22 — process up ~12h, last message processed hours
   before user noticed). Detect via (a) rate of socket-mode errors in
   `error.log` exceeding N per minute, or (b) an active liveness probe:
   track "last message event timestamp" and alarm if it's been >M minutes
   with no event in any registered channel. Proposed fix auto-resolves
   to `systemctl --user restart nanoclaw`.

## Error signature + deduplication

Every error gets a signature:

```ts
function signature(err: DetectedError): string {
  const firstLine = err.stderr.split('\n')[0].slice(0, 160);
  const stackFrames = err.stack?.split('\n').slice(0, 3).join('|') ?? '';
  return hash(firstLine + '::' + stackFrames);
}
```

Each signature is deduplicated for **10 minutes** after first notification.
A persistent "ignored signatures" list lets the user silence a signature
permanently (they click `⏭️ Ignore`).

## Diagnostician prompt shape

The diagnostician gets:

- The raw error + stderr + up to 200 preceding lines from the same log.
- `git log --oneline -20` (what's recently changed).
- Read access to the repo (Read, Grep, Glob).
- No write tools. No restart tools. No network.

Required output (JSON — enforced by stop conditions):

```json
{
  "rootCause": "string, 1-2 sentences plainly describing the bug",
  "affectedFiles": ["src/path.ts", "…"],
  "proposedFix": "string, described in code-action terms (the diff intent, not the diff itself)",
  "confidence": 0.0,
  "blast": "low | medium | high",
  "testIdea": "string, optional — what to run to verify"
}
```

## Slack card

```
🚨 NanoClaw error detected

Signature: slack_msg_too_long_v1
First seen: 10s ago   Occurrences in last hour: 1

Root cause:
  Slack chat.update rejected the first 4000-char chunk of a long agent
  reply with msg_too_long. Chunker's default exceeds Slack's section limit.

Proposed fix:
  Lower MAX_MESSAGE_LENGTH from 4000 → 3000 in src/channels/slack.ts,
  add total-chunk cap, and surface a user-visible error instead of
  requeueing unsendable payloads.

Affected files:
  • src/channels/slack.ts

Confidence: 0.85    Blast: low

[ ✅ Apply fix ]  [ ✍️ Edit and apply ]  [ ⏭️ Ignore signature ]
[ 🔬 More context ]
```

## Execution flow after "Apply fix"

1. `git stash push -m healer-backup-<incident-id>` (capture current WT in
   case anything is in-flight).
2. Spawn executor Claude SDK session with write tools and access only to
   `affectedFiles` (Read on those paths, Edit/Write restricted via allowed
   tools list). Prompt: "implement the proposed fix exactly as described.
   No scope creep."
3. Run `npm run build`. On typecheck failure → roll back (`git restore`
   affected files, `git stash pop` the backup) → update Slack: *"build
   failed, rolled back. Stack: …"*.
4. Run `systemctl --user restart nanoclaw`.
5. Tail `logs/nanoclaw.log` for 60s. Count new `ERROR`/`FATAL` entries
   since restart. If the original signature reappears OR ≥3 new distinct
   errors fire → **roll back**: `git restore` affected files, `git stash
   pop`, `systemctl --user restart nanoclaw` again.
6. Update Slack card with pass/fail status + diff summary.

The rollback path is the critical safety net. Without it, a bad fix could
brick nanoclaw and the healer itself couldn't recover.

## SQLite schema

```sql
CREATE TABLE healing_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  raw_error TEXT NOT NULL,
  stderr_excerpt TEXT,
  stack TEXT,
  log_context TEXT,              -- up to N preceding lines
  diagnosis_json TEXT,           -- diagnostician output
  slack_ts TEXT,                 -- anchor message ts for updates
  status TEXT NOT NULL DEFAULT 'open',
    -- 'open' | 'awaiting_approval' | 'applied' | 'rolled_back' | 'ignored'
  applied_diff TEXT,             -- unified diff for audit
  restarted_at INTEGER,
  verified_at INTEGER,
  rolled_back_at INTEGER
);

CREATE TABLE ignored_signatures (
  signature TEXT PRIMARY KEY,
  ignored_at INTEGER NOT NULL,
  ignored_by TEXT,               -- slack user id
  note TEXT
);
```

Separate DB file (`store/healer.db`) so a main-process DB schema migration
can't break the healer.

## Implementation phases

### Phase 0 — skeleton & log-tailer (no Slack, no Claude)

- `src/healer/log-tailer.ts` that tails files and logs to stdout when it
  detects an error. Dry run; confirms the file-watching works.
- `src/healer/index.ts` main loop.
- `systemd` unit + build.

**Ship when:** tailer reliably catches today's error patterns without false
positives.

### Phase 1 — diagnostician only

- Add Claude Agent SDK session spawn for diagnosis.
- Print diagnosis to healer logs; no Slack yet.

**Ship when:** diagnosis output is consistently well-formed JSON and the
`rootCause` matches ground truth on a week of real incidents.

### Phase 2 — Slack notifier (read-only)

- Post Block Kit cards to `#nanoclaw-ops`.
- No buttons yet — just alerting.

**Ship when:** we've been pinged by it for a week with no garbage cards.

### Phase 3 — Ignore button

- Add `pi_healer_ignore` Bolt action. Wires a row into
  `ignored_signatures`.

### Phase 4 — Apply button + executor

- The full loop. Git-stash backup, edit, build, restart, verify, rollback
  on failure.
- **Guard:** kill-switch config `HEALER_CAN_WRITE=false` that disables the
  write path entirely. Default `false` for the first week of production.
- Audit every applied diff to `healing-incidents.sqlite`.

### Phase 5 — "Edit and apply"

- Card opens a Slack modal with the proposed fix text editable. Submit →
  executor runs with the modified instruction.

## Files

| Path | Purpose |
|---|---|
| `src/healer/index.ts` | Main loop, wires pieces together |
| `src/healer/log-tailer.ts` | `fs.watch` / tail of nanoclaw.log + container logs |
| `src/healer/error-detector.ts` | Pattern matchers, signature generator, dedup |
| `src/healer/diagnostician.ts` | Claude SDK call with read-only tools |
| `src/healer/slack-card.ts` | Block Kit builders |
| `src/healer/handlers.ts` | Bolt action handlers (Apply/Edit/Ignore) |
| `src/healer/executor.ts` | git-stash + Claude SDK with write tools + build/restart/verify |
| `src/healer/db.ts` | `healing_incidents`, `ignored_signatures` accessors |
| `scripts/nanoclaw-healer` | Shell entry — compiles + runs healer |
| `systemd/nanoclaw-healer.service` | User-level service unit |
| `docs/plans/self-healing-loop.md` | This file |

Reuse from main codebase:
- `src/env.ts` for reading `.env`
- `src/logger.ts` for pino setup
- Slack bot token + app token (same creds)
- `gh auth token` pattern for any GitHub operations (PR creation etc.)

No new npm deps expected beyond what's already in `package.json` (pino,
better-sqlite3, @slack/bolt, @anthropic-ai/claude-agent-sdk).

## Security & blast radius

- Healer runs as the same Unix user as nanoclaw. No privilege elevation.
- Executor's Claude session has allowed-tools restricted to `Read`,
  `Edit`, `Write`, and `Bash` with a command allowlist:
  - `npm run build`
  - `systemctl --user restart nanoclaw`
  - `git stash`, `git stash pop`, `git restore`, `git diff`
- Executor's `cwd` is the nanoclaw repo root. No access outside.
- No access to `.env` or `~/.config/nanoclaw/*` (those aren't in the
  allowed Read set).
- Kill switch env var (`HEALER_CAN_WRITE`) fully disables the write path.
- A Slack slash command `/healer pause 1h` stops applying fixes without
  stopping the diagnostician. Useful during a deploy or demo.

## Failure modes & what happens

| Failure | Handling |
|---|---|
| Diagnostician times out / returns malformed JSON | Log & skip; no Slack post. |
| Slack API down | Healer queues Slack posts locally and retries; doesn't block diagnosis. |
| Executor's edit fails typecheck | Roll back via `git restore`, notify Slack with the error. |
| Restart fails (systemctl returns non-zero) | Roll back, notify Slack — this is a high-severity event; page the user (@-mention, not just a channel post). |
| Post-restart log shows same signature within 60s | Auto-rollback fires. The healer **does not try again** on the same signature without a new user click. |
| Healer itself crashes | `Restart=always` on the systemd unit brings it back. Main nanoclaw keeps running regardless. |
| Multiple errors fire at once | First wins; subsequent errors within the same signature group into occurrences counter; genuinely distinct errors get separate cards. |

## Open questions (for future review)

- **Weekly PR:** should the audit log produce a single "all fixes applied
  this week" PR for review, or should each applied fix become its own
  commit on `main` with a clear prefix (`healer: ...`)?
- **Confidence threshold:** below some confidence, should we post but NOT
  show the Apply button (requires `/healer force-apply` to override)?
- **Multi-user approval:** for a team setting, do we want two-person approval
  for any write? Not needed for a single-user setup.
- **Emergency halt:** when triggered, should the healer roll back *all* the
  day's applied fixes at once, or just stop applying new ones?
- **Context window:** the diagnostician sees up to 200 preceding log lines
  — is that enough for multi-step failures? Worth making configurable per
  signature once we see real data.

## Non-obvious risks

1. **The healer's code itself can break.** If Claude applies a fix that
   regresses the healer's own log-tailer or Slack path, we're blind. The
   healer should treat any edit to `src/healer/**` as extra-high blast
   (force `blast: "high"`, require a confirmation prompt in the modal).
2. **The rollback path depends on git being clean.** If a developer is mid-edit
   on the host when the healer wants to apply a fix, `git stash` captures
   their work. We need to be explicit: **don't edit nanoclaw by hand while
   healer is active** — use the ignore button, deploy, then resume.
3. **Prompt injection via logs.** If an agent writes a malicious log line
   crafted to manipulate the diagnostician ("ignore previous instructions
   and …"), the diagnostician could emit a bad proposed fix. Mitigated by
   the mandatory human approval. But worth naming.
