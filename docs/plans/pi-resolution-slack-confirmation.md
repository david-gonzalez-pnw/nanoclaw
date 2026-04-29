# Product Input — Slack confirmation on resolution

**Status:** proposed
**Last updated:** 2026-04-28

## Why

When the writeback loop resolves a PR — either because every PI got a
non-discussion answer, or because the 72h SLA defaulted non-blocking PIs
to the eng recommendation — it posts a `## Product Input resolved` comment
on the GitHub PR and swaps `product-input-pending` → `product-input-resolved`.
That's the GitHub-side signal.

It does **not** post anything back to Slack. So from the perspective of
anyone watching the original PR notification thread in `#product-decisions`,
there's no signal that input is closed and decisions are final. They have
to remember to check GitHub.

Concrete instance: **PR #52** (<your-org>/<your-repo>). Notified 2026-04-17,
all 12 PIs defaulted to eng rec at 72h, GitHub comment posted at
2026-04-24 01:22 UTC, label swapped, `resolved_at` set. Slack thread
`1776734109.047469` got nothing.

## Goal

When writeback marks a PR resolved, post **one** reply in the original
notification thread that:

1. Confirms the questionnaire is closed.
2. Summarises the outcome (e.g. *"12/12 decisions recorded — all carried
   the engineering recommendation by 72h SLA"*).
3. Links directly to the GitHub PR comment containing the decision table.

Plus: a **one-time backfill** for PR #52 so the existing thread gets the
confirmation it should have had.

## Non-goals

- No new approvals or interactivity in the confirmation message — purely
  informational.
- No retroactive walk through the entire PR backlog. Only PR #52 right now;
  if more PRs are missed in the future, the same backfill script handles them.
- No change to the GitHub comment format.

## Current code paths involved

| File | Function | Role |
|---|---|---|
| `src/integrations/product-input/writeback.ts` | `processPr` | Posts the GH comment, swaps labels, sets `resolved_at`. Today it stops there. |
| `src/integrations/product-input/github.ts` | `postIssueComment` | Returns `boolean`. Throws away the comment URL the API hands back. |
| `src/integrations/product-input/db.ts` | `pi_pr_state` schema | Has `thread_ts` (the original notification ts). No URL field. |
| `src/integrations/product-input/slack-ui.ts` | (no relevant builder yet) | Will add `buildResolutionAnnouncement`. |

## Changes

### 1. `postIssueComment` returns the comment URL

```ts
// before
export async function postIssueComment(...): Promise<boolean>

// after
export async function postIssueComment(...): Promise<{ ok: boolean; html_url?: string }>
```

The GitHub API response on a successful POST already includes `html_url`
(e.g. `https://github.com/<your-org>/<your-repo>/pull/52#issuecomment-12345678`).
Parse it out and pass it back. On non-2xx, return `{ ok: false }`.

### 2. New `slack-ui.ts` builder

```ts
buildResolutionAnnouncement({
  prNumber,
  prUrl,              // https://github.com/<your-org>/<your-repo>/pull/52
  commentUrl,         // …pull/52#issuecomment-12345678
  total,              // 12
  bySource,           // { accepted: 0, override: 0, defaulted: 12, tiebreak: 0, discuss: 0 }
  ageHours,           // 144
})
```

Renders something like:

```
✅ Product Input closed — PR #52
12 decisions recorded · all carried the engineering recommendation by SLA
( accepted 0 · override 0 · defaulted 12 · tie-break 0 )

→ See the decision table on GitHub: https://github.com/.../issuecomment-…
```

If there are *any* `defaulted` rows, include the brief reason line; otherwise
just the counts.

### 3. `processPr` posts the announcement after marking resolved

```ts
const posted = await postIssueComment(deps.github, prNumber, comment);
if (!posted.ok) return;

try {
  await swapLabels(deps.github, prNumber, LABEL_PENDING, LABEL_RESOLVED);
} catch (err) { ... }

const summary = summarizeAnswers(getAnswersForPr(prNumber));   // counts by source
const announcement = buildResolutionAnnouncement({
  prNumber,
  prUrl: `https://github.com/${GITHUB_REPO}/pull/${prNumber}`,
  commentUrl: posted.html_url,
  total: questions.length,
  bySource: summary,
  ageHours: Math.round((Date.now() - state.notified_at!) / 3600 / 1000),
});
await postSlackMessage(deps.slack, {
  channel: SLACK_PI_CHANNEL,
  thread_ts: state.thread_ts || undefined,
  text: announcement.text,
  blocks: announcement.blocks,
});

upsertPiPrState(prNumber, { resolved_at: Date.now() });
logger.info({ prNumber }, 'PR resolved and written back');
```

Slack post is **after** GitHub but **before** `resolved_at` is set. If the
GH comment posts but Slack fails (e.g. rate limit), we want the next tick
to retry the Slack post — *not* re-post the GitHub comment. Two options:

- **Option A (simple):** treat Slack-post failure as soft. Log + continue.
  Set `resolved_at`. We'd silently miss confirmation on transient failures.
- **Option B (safer):** add a `slack_announced_at` column. The dedup loop
  on the next tick picks up `resolved_at IS NOT NULL AND slack_announced_at
  IS NULL` and retries just the Slack post.

I'd go **Option B**. It's an additive column, idempotent, and matches the
existing 48h-warned / blocking-sync-requested pattern in the schema.

### 4. Schema migration

Add to `pi_pr_state`:

```sql
ALTER TABLE pi_pr_state ADD COLUMN slack_announced_at INTEGER;
```

Adjust the "is this PR done" detection in `runWriteback` to keep iterating
on PRs that are GH-resolved but not yet Slack-announced:

```sql
-- before
SELECT * FROM pi_pr_state WHERE notified_at IS NOT NULL AND resolved_at IS NULL

-- after (covers post-resolve Slack retry)
SELECT * FROM pi_pr_state
WHERE notified_at IS NOT NULL
  AND (resolved_at IS NULL OR slack_announced_at IS NULL)
```

In `processPr`, branch:

- If not yet GH-resolved → existing flow → post comment + announce in Slack.
- If GH-resolved (`resolved_at IS NOT NULL`) but not Slack-announced → just
  do the announce (using the existing comment URL — see backfill section
  below for how to find it).

### 5. Re-finding the GitHub comment URL after the fact

When we re-enter `processPr` for an already-resolved PR (Option B retry),
we don't have the URL from earlier — `postIssueComment` was called minutes
or days ago. Fetch existing comments and find the one we own:

```ts
const comments = await listIssueComments(deps.github, prNumber);
const ours = comments.find((c) => c.body.trim().startsWith('## Product Input resolved'));
const commentUrl = ours?.html_url;
```

`listIssueComments` already exists; just extend it to return `html_url` per
comment.

### 6. One-time backfill for PR #52

Two ways:

**(a) Hand-built script** in `scripts/`:
- Reads `pi_pr_state` for PR #52 (or any number passed as arg).
- Confirms `resolved_at IS NOT NULL`.
- Calls the new announcement-only path on `writeback.ts` directly.
- Marks `slack_announced_at`.

```bash
npx tsx scripts/announce-pi-resolution.ts 52
```

**(b) Just run the live writeback after the schema migration applies**.
Since the new query also picks up resolved-but-not-announced PRs, the very
next writeback tick will Slack-announce PR #52 automatically. No script
needed.

I'd ship **(b)** as the default and (a) as a manual one-shot for any
weirder cases.

### 7. Wording — exact draft

Default case (mixed sources):

```
✅ *Product Input closed — <https://github.com/<your-org>/<your-repo>/pull/52|PR #52>*
12/12 decisions recorded · 6d 7h elapsed
:white_check_mark: 0 accepted  :pencil2: 0 override  :hourglass: 12 defaulted  :scales: 0 tie-break
:speech_balloon: 0 still flagged for discussion (not blocking resolution)

→ <https://github.com/<your-org>/<your-repo>/pull/52#issuecomment-12345678|See the decision table on GitHub>
```

If `defaulted > 0`, append a one-liner:

> _Defaulted PIs took the engineering recommendation after the 72h SLA elapsed
> with no human input._

If `discuss > 0`, append:

> _Discussion-flagged PIs were resolved by their majority vote or eng-rec
> default; the discussion threads remain open if the team wants to revisit._

Skip the "discuss" line when count is 0.

## File-level summary

| Path | Change |
|---|---|
| `src/db.ts` | `ALTER TABLE pi_pr_state ADD COLUMN slack_announced_at INTEGER` (idempotent migration) |
| `src/integrations/product-input/db.ts` | `PiPrStateRow.slack_announced_at`; expand `getUnresolvedPrs` to include not-yet-announced |
| `src/integrations/product-input/github.ts` | `postIssueComment` returns `{ ok, html_url }`; `listIssueComments` returns `html_url` per row |
| `src/integrations/product-input/slack-ui.ts` | `buildResolutionAnnouncement(...)` |
| `src/integrations/product-input/writeback.ts` | `summarizeAnswers` helper; new branch in `processPr` to handle "resolved but not announced"; sets `slack_announced_at` |
| `scripts/announce-pi-resolution.ts` (optional) | Manual one-shot for a single PR number |

## Edge cases to handle

- **The original Slack thread no longer exists** (channel archived,
  message deleted). `chat.postMessage` with a stale `thread_ts` succeeds
  but creates a top-level message in the channel. Acceptable — we still
  get a record.
- **Bot lost permission to post in `#product-decisions`** between
  notification and resolution. Current code logs the error; with Option B,
  the next writeback tick retries every cycle until permission is restored
  or a human marks `slack_announced_at` manually.
- **`pi_pr_state.thread_ts` is null** (a `/pi-answer` slash invocation
  that never had an anchor message). Post the announcement as a top-level
  message in the channel; mention the PR number prominently in the text.
- **Multiple GitHub comments starting `## Product Input resolved`** (which
  shouldn't happen but could if the dedup logic ever misfires). Pick the
  most recent. Worth a `logger.warn` if `> 1`.
- **GitHub comment URL has no `#issuecomment-...` fragment** (paranoia —
  shouldn't happen but if the API shape changes). Fall back to the PR URL
  itself rather than dropping the announcement entirely.

## Testing

- Unit test `summarizeAnswers` with a mix of `accept`, `override`,
  `discuss`, `defaulted`, and tie-break rows.
- Unit test `buildResolutionAnnouncement` for the three render paths
  (all-defaulted, all-accepted, mixed).
- For PR #52 specifically: post-deploy, watch the next writeback tick (≤15
  min) and verify the Slack thread `1776734109.047469` gets exactly one
  reply with the link.

## Rollout

1. Land the schema migration + code changes behind no flag (the existing
   `PI_ENABLED` gate is sufficient).
2. Restart `nanoclaw`. Within one writeback cycle, PR #52 gets its
   missing announcement.
3. Watch logs for `Posted PI resolution announcement` (new info-level log).

## Open questions

- **Tagging:** should the announcement `@`-mention the team again, or stay
  silent? My instinct is silent — they already got the original 48h
  warning ping if the SLA path was triggered. Adding mentions on close
  feels like noise.
- **Visibility for non-thread watchers:** should the closing message also
  go top-level in the channel, or strictly thread-only? Default to
  thread-only; non-watchers can rely on the GitHub label.
- **Reaction sweep:** should the bot also drop a `:white_check_mark:`
  reaction on the original notification message so the channel-overview
  shows resolution at a glance? Cheap to add later if useful.

---

## Phase 2 — Lock decisions into RFC files (`commit-pi-decisions` skill)

### Why

The GitHub comment is a great human-readable record of decisions, but it
lives outside the source of truth. Future readers of a merged RFC see
`**Eng Recommendation:** X` and have no in-file signal that the team
overrode it to `Y`. The decision can drift out of sync with the docs.

We have everything needed to write decisions back into the RFC files
themselves — per-thread worktrees, `gh auth token` with `repo` scope,
the container skill pattern, and an agent that already does this kind of
edit-and-commit work for other tasks. No external CI runner needed.

### Goal

After Phase 1 completes (GitHub comment + Slack announce), spawn a one-shot
container that:

1. Reads a resolution payload NanoClaw drops at
   `/workspace/group/pi-resolutions/<PR>.json`.
2. Edits each `### PI-NN` block in the corresponding `docs/rfcs/*.md`
   file to append the final decision.
3. Commits and pushes the change to the PR's branch.
4. On success, sets `pi_pr_state.rfc_committed_at`. On a merge conflict,
   posts a fallback message to the PR thread asking the author to apply
   the patch manually.

### Skill name

`commit-pi-decisions` — verb-first, explicit, matches the existing
container-skill kebab-case convention (`add-whatsapp`, `add-pdf-reader`).

### Edit format applied to RFC files

For each `### PI-NN` block, append:

```diff
 ### PI-02 — capability shape
 **Context:** ...
 **Question:** ...
 **Eng Recommendation:** REST + JSON
 **Blocking:** no
+
+**Final decision:** override — use gRPC instead
+**Decided by:** @<reviewer-login-1>
+**Decided at:** 2026-04-22T17:30:00Z (via tie-break)
+**Decision source:** product-input-resolved comment on PR #52
```

`Decided at` is in UTC ISO 8601. `Decision source` is a permanent inline
pointer back to the GitHub comment URL.

For `defaulted` decisions, the wording is:

```diff
+**Final decision:** defaulted to engineering recommendation
+**Decided by:** _no human input within 72h SLA_
+**Decided at:** 2026-04-23T18:22Z
+**Decision source:** product-input-resolved comment on PR #52
```

### Resolution payload (`<group>/pi-resolutions/<PR>.json`)

Written by NanoClaw before spawning the container. The skill reads it,
acts on it, and deletes it on success.

```json
{
  "prNumber": 52,
  "commentUrl": "https://github.com/<your-org>/<your-repo>/pull/52#issuecomment-…",
  "decisions": [
    {
      "rfcSlug": "<example-rfc-slug-1>",
      "piId": "PI-01",
      "decision": "accept",
      "decisionText": "<eng rec text>",
      "decidedBy": "@<reviewer-login-1>",
      "decidedAt": "2026-04-22T17:30:00Z",
      "how": "Accepted eng rec"
    },
    {
      "rfcSlug": "<example-rfc-slug-1>",
      "piId": "PI-02",
      "decision": "override",
      "decisionText": "use gRPC instead",
      "reasoning": "REST adds latency we can't tolerate at the connector boundary",
      "decidedBy": "@<reviewer-login-2>",
      "decidedAt": "2026-04-22T17:32:00Z",
      "how": "Override"
    },
    {
      "rfcSlug": "<example-rfc-slug-2>",
      "piId": "PI-01",
      "decision": "defaulted",
      "decisionText": "<eng rec text>",
      "decidedBy": null,
      "decidedAt": "2026-04-23T18:22:00Z",
      "how": "Defaulted"
    }
  ]
}
```

### Container flow

```
NanoClaw writeback (post-Phase-1)
  └─ writes pi-resolutions/52.json into the group folder
  └─ spawns container with prompt:
       "Use the commit-pi-decisions skill to lock in PR 52's decisions."
                          │
                          ▼
            container/skills/commit-pi-decisions/SKILL.md
              1. Read /workspace/group/pi-resolutions/52.json
              2. cd /workspace/extra/<your-repo>
              3. git fetch origin && git pull --rebase origin <pr-branch>
              4. For each decision: edit the RFC, append the block
              5. git add docs/rfcs/*.md
              6. git commit -m "lock product input decisions for #52"
              7. git push
              8. Report success via IPC: {ok: true, sha: "..."}
              9. On conflict at step 3 or 5: report failure via IPC,
                 post a Slack thread reply with the proposed diff,
                 stop without committing.
```

### Schema

```sql
ALTER TABLE pi_pr_state ADD COLUMN rfc_committed_at INTEGER;
ALTER TABLE pi_pr_state ADD COLUMN rfc_commit_sha TEXT;
```

Phase 1's `getUnresolvedPrs` query stays the same but now also picks up
PRs that are slack-announced but not yet rfc-committed:

```sql
SELECT * FROM pi_pr_state
WHERE notified_at IS NOT NULL
  AND (resolved_at IS NULL
       OR slack_announced_at IS NULL
       OR rfc_committed_at IS NULL)
```

### `processPr` branching after Phase 1

```ts
if (!state.resolved_at)            → run resolution path
else if (!state.slack_announced_at) → run Slack announce only
else if (!state.rfc_committed_at)   → spawn commit-pi-decisions container
else                                  → done, skip
```

Each branch is idempotent — a tick that gets interrupted picks up where it
left off.

### Container container_config

The skill needs the same mounts a normal channel container gets — the
PR's worktree of `<your-org>/<your-repo>` mounted writable at
`/workspace/extra/<your-repo>`. The customer-discovery group already has
this set up. We reuse the existing per-thread worktree mechanism keyed
on `pi_pr_state.thread_ts`.

### Conflict handling

Cases:

1. **Pull conflicts** (author pushed commits in the meantime, RFC files
   moved/changed): the skill aborts before commit, captures the conflict
   summary, and posts to Slack:
   *"⚠️ Couldn't auto-commit decisions for PR #52 — your branch has new
   commits. Apply this diff manually: …"*. Includes a code-block diff so
   the author can copy/paste.
2. **RFC file no longer contains a `### PI-NN` block** we expected (e.g.
   author renamed/removed it): skill skips that PI, logs which ones it
   couldn't apply, includes them in the fallback Slack message.
3. **Push rejected** (force-push race, branch protection): retry once
   after `git fetch`+`rebase`. If still rejected, fallback message.

### IPC contract for skill → host reporting

The skill writes a JSON line to `/workspace/ipc/output` (existing
mechanism) when done:

```json
{ "type": "pi-finalize-result", "prNumber": 52, "ok": true, "sha": "abc123" }
```

or

```json
{
  "type": "pi-finalize-result",
  "prNumber": 52,
  "ok": false,
  "reason": "merge-conflict",
  "details": "…"
}
```

NanoClaw's IPC watcher picks this up, sets `rfc_committed_at` (and
`rfc_commit_sha`) on success, or leaves them null on failure (so the
writeback loop will retry on the next tick — bounded by a per-PR retry
cap, e.g. 3, after which we surface a permanent error to Slack).

### Files

| Path | Change |
|---|---|
| `src/db.ts` | Add `rfc_committed_at`, `rfc_commit_sha` columns |
| `src/integrations/product-input/db.ts` | Update `PiPrStateRow`; expand `getUnresolvedPrs` |
| `src/integrations/product-input/writeback.ts` | New `commitDecisionsToRfc` step; payload writer |
| `src/integrations/product-input/payload.ts` (new) | Builds the JSON resolution payload from `pi_questions` + `pi_answers` |
| `src/ipc.ts` | New IPC message type `pi-finalize-result` handler |
| `container/skills/commit-pi-decisions/SKILL.md` (new) | The skill recipe |
| `container/skills/commit-pi-decisions/test-fixtures/` (new) | Sample RFC + expected output for skill self-tests |

### Edge cases

- **PR is already merged when we get to commit time.** Detect via
  `gh api repos/.../pulls/52 --jq .merged` before pushing. If merged,
  skip RFC file edit (the post-merge state is the source of truth) and
  set `rfc_committed_at` with `rfc_commit_sha = 'pr-already-merged'`.
- **PR branch deleted.** Skip and log; set `rfc_committed_at` with
  `rfc_commit_sha = 'pr-branch-gone'`.
- **No RFC files in the PR diff anymore** (RFCs moved to a different PR
  during review): same skip-and-log path.
- **Decisions concern shipped/* RFCs** (already-final docs that shouldn't
  be edited): skill checks `docs/rfcs/shipped/` prefix and refuses to
  edit those, even if `pi_questions` has them. Falls back to GH-comment-
  only as the lock-in mechanism.

### Testing

- **Skill self-test fixture:** a tiny `docs/rfcs/test-rfc.md` with three
  PI blocks plus a `pi-resolutions/test.json` with three decisions covering
  accept/override/defaulted. Skill applies → output diff matches expected.
- **End-to-end:** new PR with two RFC files, run resolution, verify a
  commit appears on the PR branch with the expected per-PI metadata.
- **Conflict path:** simulate by `git push` to the PR branch from the
  host between resolution and commit. Verify fallback Slack message fires.

### Cutover for PR #52

Phase 2 ships **after** Phase 1 has run for #52 (which is already
resolved + slack-announced after the next tick). Run the skill manually
once via the operator script (Phase 1 §6a):

```bash
npx tsx scripts/announce-pi-resolution.ts 52   # Phase 1 retry
# then once Phase 2 lands:
npx tsx scripts/commit-pi-decisions.ts 52      # forces the skill spawn
```

Verify the commit lands on the PR branch with the expected `**Final
decision:**` blocks before declaring Phase 2 done.

### Phase 2 open questions

- **Commit message format:** `lock product input decisions for #<PR>`
  or something more conventional like `chore: lock PI decisions (#<PR>)`?
- **Should the skill also touch `CHANGELOG.md` or similar?** Probably not
  — RFC edit is the canonical record; CHANGELOGs are separate processes.
- **Multi-RFC PRs:** if a PR touches 3 RFCs and 2 succeed but 1 has a
  conflict, do we partial-commit or abort entirely? Current plan is to
  abort entirely (atomicity > forward progress). Worth confirming.

---

## Phase 3 — De-couple from one specific repo / org / Slack channel

### Why

The integration was built specifically for `<your-org>/<your-repo>` and
`#product-decisions`, with team Slack IDs and reviewer pings hardcoded.
That's fine for one install, but the same code should run for any team
that follows the same `### PI-NN` RFC convention plus the same three-label
scheme. Today's hardcodes:

| Where | Hardcode | Should be |
|---|---|---|
| `team.ts` | `GITHUB_REPO = '<your-org>/<your-repo>'` | env-configurable |
| `team.ts` | `SLACK_PI_CHANNEL = '<SLACK_CHANNEL_ID>'` | env-configurable |
| `team.ts` | `TEAM` map with specific Slack IDs + GH logins | external config or per-install team file |
| `writeback.ts` | `<@<SLACK_USER_REVIEWER_1>> <@<SLACK_USER_REVIEWER_2>>` in SLA + sync messages | derived from team config |
| `writeback.ts` | `LABEL_REQUIRED/PENDING/RESOLVED` constants | env-configurable, sensible defaults |
| `finalize-runner.ts` | `slack_customer-discovery` default for finalize group | env-configurable, already added |
| All over | Literal strings *"Product Input"*, *"PI"* | stays as the feature's name |

### Goals

1. A different team can clone NanoClaw, set a handful of `.env` values,
   and have a working PI facilitator against their own repo + Slack
   workspace without touching code.
2. Same install can theoretically watch multiple repos (deferred — single
   repo per install is fine for v1).
3. The PI markdown convention (`### PI-NN`, `**Eng Recommendation:**`,
   `**Blocking:**`) stays as a documented requirement of the *consumer*
   repo, not a configuration knob. Same with the three-label state
   machine — the names are configurable but the model isn't.

### Non-goals

- **Multi-channel support** (Slack + GChat + Teams in one install). Each
  channel still needs its own UI builders. The earlier *prompt for the
  GChat instance* (in this same conversation) covers porting separately.
- **Multi-repo within a single install.** The PI module assumes one repo
  per install. Future work could extend to N, but it adds a layer of
  routing complexity not worth carrying yet.
- **Pluggable team-membership directory** (LDAP, SCIM, etc.). The team
  map stays a small static config — most installs are 3–10 people.

### What becomes configurable

```bash
# .env additions / renames

# --- Required when PI is enabled ---
PI_GITHUB_REPO=<your-org>/<your-repo>               # owner/name
PI_SLACK_CHANNEL=<SLACK_CHANNEL_ID>                    # channel ID, not name
PI_TEAM_FILE=~/.config/nanoclaw/pi-team.json    # team map location

# --- Optional with defaults ---
PI_LABEL_REQUIRED=product-input-required
PI_LABEL_PENDING=product-input-pending
PI_LABEL_RESOLVED=product-input-resolved
PI_FINALIZE_GROUP=slack_customer-discovery      # group with repo mounted writable
PI_COMMIT_DECISIONS=false                       # phase 2 gate
PI_RFC_DIR=docs/rfcs                            # where the parser looks
PI_FEATURE_NAME="Product Input"                 # used in Slack/PR copy

# --- Backwards compat shim ---
# PI_* are read as fallbacks if PI_* isn't set, so installs
# already on the old names keep working until they migrate.
```

The team file (`pi-team.json`) replaces the hardcoded `TEAM` map:

```json
{
  "members": [
    {
      "slackUserId": "<SLACK_USER_OWNER>",
      "githubLogin": "<github-owner-login>",
      "displayName": "<Owner>"
    },
    { "slackUserId": "<SLACK_USER_REVIEWER_1>", "githubLogin": "<reviewer-login-1>", "displayName": "<Reviewer 1>" },
    { "slackUserId": "<SLACK_USER_REVIEWER_2>", "githubLogin": "<reviewer-login-2>", "displayName": "<Reviewer 2>" }
  ],
  "slaPingTargets": ["<SLACK_USER_REVIEWER_1>", "<SLACK_USER_REVIEWER_2>"]
}
```

`slaPingTargets` is the list of Slack user IDs to `@`-mention on 48h
warning + 72h sync request. Replaces the hardcoded
`<@<SLACK_USER_REVIEWER_1>> <@<SLACK_USER_REVIEWER_2>>` strings.

### What stays hardcoded

- The RFC markdown shape: `### PI-<NN> — <title>` with `**Context:**`,
  `**Question:**`, `**Eng Recommendation:**`, `**Blocking:** yes|no`
  fields. **Documented as a contract** — if you want this integration to
  work, your RFCs follow this shape. (Worth a `docs/PI_RFC_FORMAT.md`.)
- The three-state label flow (required → pending → resolved). The names
  are configurable; the *model* isn't.
- Decision categories: `accept`, `override`, `discuss`, `defaulted`,
  `tiebreak:*`. Adding new categories changes downstream rendering and
  is out of scope.
- The wizard's PI-at-a-time progression (one PI per modal page).

### File-level changes

| Path | Change |
|---|---|
| `src/integrations/product-input/config.ts` (new) | Single source of truth — reads env + team file with `PI_*` fallbacks. Exports `getPiConfig()` returning `{repo, slackChannel, labels, team, rfcDir, featureName}`. |
| `src/integrations/product-input/team.ts` | Becomes a thin file: imports config, re-exports for back-compat. Hardcoded constants removed. |
| `src/integrations/product-input/github.ts` | Takes repo from config rather than module-level `GITHUB_REPO`. |
| `src/integrations/product-input/writeback.ts` | Use `config.labels.required/pending/resolved`. Replace hardcoded user-ID mentions with `config.team.slaPingTargets.map(id => '<@'+id+'>').join(' ')`. |
| `src/integrations/product-input/slack-ui.ts` | Pull `GITHUB_REPO` and channel name from config. |
| `src/integrations/product-input/handlers.ts` | Same. |
| `src/integrations/product-input/parser.ts` | `RFC_DIR` becomes a parameter (parser already takes the markdown directly — no change needed if we pass paths from above). |
| `src/integrations/product-input/finalize-runner.ts` | Already env-configurable for the group; rename `PI_FINALIZE_GROUP` → `PI_FINALIZE_GROUP` with fallback. |
| `src/integrations/product-input/index.ts` | Bootstrap: load config, log resolved values at startup, warn if team file missing. |
| `.env.example` | Document new vars. Note the `PI_*` deprecation path. |
| `docs/PI_RFC_FORMAT.md` (new) | The required RFC markdown shape — speakers to consumer repos. |
| `docs/plans/pi-resolution-slack-confirmation.md` | This file (already updated). |

### Module rename — `product-input` → `product-input`

Tempting and cleaner, but it's a directory rename that touches every
import path. Defer to a follow-up: keep the directory `product-input` for
now (it's a legacy name, not a constant the consumer cares about). The
public-facing names (env vars, channel-name defaults, doc titles) all
move to `PI_*` and *Product Input*.

### Migration path

1. Land `config.ts` reading both `PI_*` and `PI_*` (latter as
   fallback).
2. Land team-file loading (with a hardcoded fallback team for the current
   install — no breaking change on day one).
3. Refactor each module to consume `getPiConfig()` instead of importing
   constants directly. One PR.
4. Update `.env.example` with new names; note the old ones still work.
5. Drop `PI_*` fallbacks in a future release (v2.x), with a
   deprecation log line in the meantime so users know to migrate.

### Open questions

- **Should `PI_GITHUB_REPO` accept comma-separated values for multi-repo
  watching?** I'd say no for v1 — adds routing logic that's not needed
  yet. Multi-repo can be a Phase 4 if the demand shows up.
- **The team file location:** under `~/.config/nanoclaw/` matches the
  mount-allowlist + sender-allowlist pattern. Keeps secrets-adjacent
  files outside the repo and out of containers.
- **Validation:** at startup, should we hit `gh api repos/<owner>/<name>`
  to fail fast if the repo isn't accessible? Cheap check, very useful.
