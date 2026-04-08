---
name: safety
description: Safety rules for destructive operations. The agent must ask for confirmation before modifying production infrastructure, pushing code, or deleting resources. These rules override all other skill instructions.
---

# Safety Rules

These rules apply to ALL operations. They override any other skill instructions.

## Destructive Operations (MUST confirm)

Before running any of these commands, you MUST:
1. Explain what the command will do and what it will change
2. Show the exact command you plan to run
3. Ask the user for explicit approval in the thread
4. Wait for a confirmation message before executing

### Cloud infrastructure
- `gcloud * update`, `gcloud * deploy`, `gcloud * delete`, `gcloud * create`
- `gcloud run services update`, `gcloud functions deploy`
- `gcloud sql *`, `gcloud firestore *` (any write operation)
- Any `gcloud` command with `--set-env-vars`, `--update-env-vars`, `--remove-env-vars`

### Git operations
- `git push` (any remote push)
- `git branch -D` / `git branch -d` (branch deletion)
- `git reset --hard`
- `gh pr merge`

### File operations on mounted repos
- Deleting files outside the worktree
- Modifying config files (`.env`, `firebase.json`, `cloudbuild.yaml`, etc.)

### GitHub
- `gh pr create` — show the title, body, and branch first
- `gh pr merge` — always confirm
- `gh issue close`

## Safe Operations (no confirmation needed)

These are read-only and can run freely:
- `gcloud * list`, `gcloud * describe`, `gcloud * get`
- `gcloud logging read`
- `gcloud run services describe`
- `gcloud functions describe`
- `git status`, `git log`, `git diff`, `git branch` (list)
- `gh pr list`, `gh pr view`, `gh issue list`
- `gh pr create --draft` — drafts are safe (show title/body after)
- Any `Read`, `Glob`, `Grep` operation
- `npm test`, `npm run build`, `make test`

## How to ask for confirmation

Post a message in the thread with:
1. What you're about to do (plain language)
2. The exact command
3. What the expected impact is
4. Ask: "Should I proceed?"

Example:
> I'd like to update the `my-worker` Cloud Run service to add the missing `FIREBASE_CONFIG` env var:
> ```
> gcloud run services update my-worker \
>   --region us-central1 \
>   --update-env-vars FIREBASE_CONFIG='{"projectId":"my-project-id"}'
> ```
> This will restart the service with the new env var. Should I proceed?

Then WAIT for the user to reply with confirmation before executing.

## If unsure

If you're not sure whether an operation is destructive, treat it as destructive and ask.
