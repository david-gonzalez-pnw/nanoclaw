---
name: commit-pi-decisions
description: Lock the resolved Product Input decisions for a PR into the RFC files in git. Reads a resolution payload at /workspace/group/pi-resolutions/<PR>.json, edits each `### PI-NN` block in the corresponding `docs/rfcs/*.md` file, then commits and pushes to the PR's branch. Reports the result as a single JSON line at the end of output.
---

# Lock Product Input Decisions Into RFC Files

When invoked you will receive a prompt naming a PR number, e.g. *"Use the
commit-pi-decisions skill to lock in the decisions for PR 52."*

The host has already:

1. Posted a `## Product Input resolved` comment to the GitHub PR
2. Swapped the label to `product-input-resolved`
3. Posted a closing announcement to Slack

Your job is the final step: bake the decisions into the RFC source files
themselves so the merged docs reflect what the team actually decided
(rather than only the engineering recommendation).

## Inputs

- `/workspace/group/pi-resolutions/<PR>.json` — the resolution payload.
  Schema:
  ```json
  {
    "prNumber": 52,
    "prHeadRef": "feat/integration-capabilities",
    "commentUrl": "https://github.com/<owner>/<repo>/pull/52#issuecomment-…",
    "decisions": [
      {
        "rfcSlug": "2026-04-20-integration-capability-contract",
        "piId": "PI-01",
        "decision": "accept" | "override" | "discuss" | "defaulted",
        "decisionText": "<final decision text>",
        "reasoning": "<override reasoning, may be null>",
        "decidedBy": "@<github-login>" | null,
        "decidedAt": "2026-04-22T17:30:00Z",
        "how": "Accepted eng rec" | "Override" | "Defaulted" | "Tie-break"
      }
    ]
  }
  ```
- `/workspace/extra/<repo>  (the path is given as `repoMountPath` in the payload)` — a writable worktree of <owner>/<repo>.
  `gh` is authenticated; `git` is configured.

## Steps

1. **Read the payload.** `cat /workspace/group/pi-resolutions/<PR>.json` and
   parse it. If the file is missing or malformed, output the failure JSON
   and stop.

2. **Prepare the worktree.**
   ```bash
   cd /workspace/extra/<repo>  (the path is given as `repoMountPath` in the payload)
   git fetch origin
   git checkout "$PR_HEAD_REF"
   git pull --rebase origin "$PR_HEAD_REF"
   ```
   If pull-rebase fails with conflicts, **stop**. Output the failure JSON
   with `reason: "merge-conflict"` and the conflict summary in `details`.
   Do not commit.

3. **Edit each RFC.** For each decision:
   - Open `docs/rfcs/<rfcSlug>.md`.
   - Find the `### PI-<NN>` heading line. The PI block runs until the next
     `### ` heading or end-of-file.
   - **Skip** if the block already contains a `**Final decision:**` line —
     the skill is idempotent. Log the skip; do not error.
   - **Skip** if the file is under `docs/rfcs/shipped/` — already-shipped
     RFCs must not be modified.
   - Append a decision block at the end of the PI's section, before the
     next heading. Use this exact format (no leading blank line, single
     trailing newline):

     ```
     **Final decision:** <wording>
     **Decided by:** <decidedBy or _no human input within 72h SLA_>
     **Decided at:** <decidedAt>
     **Decision source:** <commentUrl>
     ```

     Wording per `decision`:
     - `accept` → `accepted engineering recommendation`
     - `override` → `override — <decisionText>` (and on a new line: `**Reasoning:** <reasoning>`)
     - `defaulted` → `defaulted to engineering recommendation`
     - `discuss` → `flagged for discussion (no final decision)` *(rare in
       practice — should only appear if SLA expired before the discuss
       was resolved)*

   - If the decision is `discuss`, prefer **not** to commit it (no
     real outcome to lock in). Track it as skipped in the result.

4. **Stage and commit.** If any files changed:
   ```bash
   git add docs/rfcs/*.md
   git commit -m "lock product input decisions for #<PR>

   Source: <commentUrl>"
   ```
   Capture the new commit SHA: `git rev-parse HEAD`.

5. **Push.**
   ```bash
   git push origin "$PR_HEAD_REF"
   ```
   On rejection (force-push race, branch protection): retry once with
   `git fetch origin && git rebase origin/$PR_HEAD_REF` then push again.
   If still rejected, output failure JSON with `reason: "push-rejected"`.

6. **Clean up.** Delete the resolution payload:
   ```bash
   rm /workspace/group/pi-resolutions/<PR>.json
   ```

7. **Report.** Emit **exactly one JSON line** to stdout as the very last
   thing you output. Examples:

   Success:
   ```json
   { "type": "pi-finalize-result", "prNumber": 52, "ok": true, "sha": "abc123def", "applied": 12, "skipped": 0 }
   ```

   No-op (idempotent re-run, nothing changed):
   ```json
   { "type": "pi-finalize-result", "prNumber": 52, "ok": true, "sha": null, "applied": 0, "skipped": 12, "reason": "already-locked" }
   ```

   Failure:
   ```json
   { "type": "pi-finalize-result", "prNumber": 52, "ok": false, "reason": "merge-conflict", "details": "RFC docs/rfcs/foo.md modified upstream — conflicts in PI-02, PI-04" }
   ```

## Important constraints

- **Atomicity over progress.** If editing one RFC fails or has a conflict,
  do not commit the others. Output failure and let the host retry on the
  next tick.
- **Never amend or force-push.** Only fast-forward. If the branch state
  diverges from what you expected, fail and report.
- **Do not edit `docs/rfcs/shipped/*`.** That directory holds already-
  finalized RFCs.
- **Do not modify other files** beyond `docs/rfcs/*.md` and the resolution
  payload itself.
- **No interactive operations.** Output the result JSON line and exit.

## Conflict-handoff message template

When you fail with `merge-conflict` or `push-rejected`, additionally write
a short markdown block describing the proposed diff so the host can paste
it into Slack. Include it on stderr (or as part of `details`). The host
will route it to the PR's notification thread tagging the author.
