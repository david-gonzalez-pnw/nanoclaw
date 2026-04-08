---
name: code-tasks
description: Handle code change requests — bug fixes, feature implementations, designs, and reviews. Works in per-thread worktrees with isolated branches. Commits, runs tests, and opens PRs.
---

# Code Tasks

You can make code changes when asked. You're working in a git worktree on an isolated branch — your changes don't affect the main branch until merged.

## Detecting a code task

Act on requests like:
- "fix this bug", "plan a fix", "make a fix for..."
- "implement XYZ", "add this feature", "change this behavior"
- "create a design for...", "how would you approach..."
- "review this code", "what's wrong with..."
- Any request that includes screenshots, error logs, or stack traces alongside a request for changes

## Context you have access to

- **Mounted repos** at `/workspace/extra/` — browse with `ls /workspace/extra/`
- **Screenshots** — if the user attached an image, it's referenced in the message as `[Attached image: /workspace/group/uploads/...]`. Use the Read tool to view it.
- **Thread history** — prior messages in the thread are included for context
- **Group memory** — check `/workspace/group/CLAUDE.md` for project-specific context

## Workflow by request type

### "Plan a fix" / "Create a design" / "How would you approach..."

Analysis only — don't make changes:
1. Read the relevant code
2. Analyze the problem using any context (screenshots, error logs, thread history)
3. Respond in the thread with your analysis and proposed approach
4. Include specific file paths and line numbers
5. Ask if they want you to implement it

### "Fix this" / "Implement XYZ" / "Make this change"

Full implementation:

1. **Understand** — Read the relevant code, analyze screenshots/errors, review thread context
2. **Locate** — Find the files that need changes using Glob and Grep
3. **Implement** — Make the changes using Edit/Write. Keep changes minimal and focused.
4. **Test** — Run the repo's test command. Detect the right one:
   ```bash
   cd /workspace/extra/<repo-name>
   # Check what's available (in order of preference)
   if [ -f Makefile ] && grep -q '^test:' Makefile; then make test
   elif [ -f package.json ] && grep -q '"test"' package.json; then npm test
   elif [ -f pytest.ini ] || [ -f pyproject.toml ]; then pytest
   else echo "No test runner found — skip tests"
   fi
   ```
   If tests fail, fix them before proceeding.
5. **Commit** — Stage and commit with a clear message:
   ```bash
   cd /workspace/extra/<repo-name>
   git add -A
   git commit -m "fix: description of what was fixed

   - Bullet points of specific changes
   - Reference the issue or context from the thread"
   ```
6. **Push + PR** — Push the branch and open a draft PR:
   ```bash
   cd /workspace/extra/<repo-name>
   git push origin HEAD
   gh pr create --draft --title "fix: short description" --body "## Summary
   - What was changed and why

   ## Context
   - Link back to the Slack thread or describe the original issue

   ## Testing
   - How this was tested"
   ```
7. **Report** — Reply in the thread with:
   - What you changed (files and brief description)
   - **The PR link** (REQUIRED — capture the URL from `gh pr create` output and include it)
   - Any caveats or follow-up needed

   If git/push/PR fails for any reason, report the error and explain how to complete the process manually.

### "Review this code" / "What's wrong with..."

Read and analyze only:
1. Read the relevant code
2. Identify issues, potential bugs, or improvements
3. Respond with findings — include file paths and line numbers
4. If they want fixes, ask before implementing

## Important rules

- **Always read before writing** — understand the existing code before making changes
- **Minimal changes** — only change what's needed for the task. Don't refactor surrounding code, add comments to unchanged code, or "improve" things that weren't asked for.
- **One concern per commit** — if the task involves multiple distinct changes, make separate commits
- **Test before committing** — if `npm test` exists and is relevant, run it
- **Ask if unsure** — if the request is ambiguous or you'd need to make a judgment call that significantly affects the approach, ask in the thread before proceeding
- **Report what you did** — always summarize changes in the thread after completing work

## Working with screenshots

When a message includes `[Attached image: ...]`, read the image file to see the screenshot. Use it to:
- Identify UI bugs (layout issues, wrong text, broken styling)
- Read error messages or stack traces from console screenshots
- Understand the current state of the application
- See what the user is seeing

## Multiple repos

You may have multiple repos mounted. Check what's available:
```bash
ls /workspace/extra/
```

Make sure you're working in the correct repo for the task. If the user doesn't specify, infer from the context or ask.
