# NanoClaw (Fork)

Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) with additional features for plugin-based extensibility, per-thread isolation, and Slack integration.

For core NanoClaw documentation (setup, philosophy, architecture, FAQ), see the [upstream README](https://github.com/qwibitai/nanoclaw#readme).

---

## What This Fork Adds

### Plugin System

Declarative plugin architecture via `plugins/` manifests. Each plugin declares its prerequisites, container mounts, MCP servers, entrypoint commands, allowed tools, and container skills. The host resolves active plugins at container launch time -- no code changes needed to add or remove capabilities.

**Included plugins:**

| Plugin | What It Does |
|--------|-------------|
| `gh` | GitHub CLI inside containers -- PRs, issues, code review. Reads token from `~/.config/nanoclaw/github-token` |
| `gcloud` | Google Cloud CLI with service account auth |
| `gcpLogging` | GCP Cloud Logging MCP server -- query logs from inside containers |
| `azure` | Azure CLI + azd -- manage resources, deploy infrastructure. Authenticates via service principal |
| `appInsights` | Azure Application Insights MCP server -- KQL queries for traces, exceptions, requests, and metrics |
| `codeTasks` | Code task execution MCP server |
| `worktrees` | Per-thread git worktree lifecycle management |

Plugins are opt-in: if a plugin's prerequisites aren't met (e.g., no GitHub token file), it's silently skipped.

### Per-Thread Worktree Isolation

Each Slack thread gets its own git worktree for writable repo mounts. Concurrent threads work on isolated branches without conflicts. Worktrees are:

- Created on first use per thread
- Reused across messages in the same thread
- Cleaned up daily via a background cron job (configurable via `WORKTREE_CLEANUP_CRON`)
- Tracked in SQLite with retention support

### Per-Thread Container Slots

The group queue was refactored from one container per group to one container per thread. Each thread independently manages its container lifecycle, IPC input directory, retry logic, and idle timeout. Non-threaded messages and scheduled tasks use a default slot.

### Slack Channel

Full Slack integration via `@slack/bolt` Socket Mode:

- Thread-aware message routing with parent thread backfill
- "Processing..." placeholder messages updated with real responses
- Slack Assistant API (dedicated 1:1 panel with suggested prompts)
- Image attachment downloads to group uploads directory
- Automatic `@mention` to trigger pattern translation
- User name resolution with caching
- Message chunking at 4K character limit

### Container Enhancements

- **Google Cloud CLI**, **Azure CLI**, and **GitHub CLI** installed in the container image
- **Externalized entrypoint** (`container/entrypoint.sh`) with plugin command execution
- **Dynamic MCP servers** -- plugins contribute MCP servers via base64-encoded env vars
- **Dynamic allowed tools** -- plugins extend the tool allowlist
- **Plugin-aware skill sync** -- container skills owned by a plugin only sync when that plugin is active

### Additional Container Skills

| Skill | Purpose |
|-------|---------|
| `code-tasks` | Structured code generation and modification tasks |
| `safety` | Safety guardrails for agent behavior |

### Background Job Scheduler

Bree-based worker thread scheduler for background maintenance tasks. Currently runs worktree cleanup on a configurable cron schedule (default: daily at 3 AM).

### Fork Sync CI

`.github/workflows/fork-sync-skills.yml` -- automatically syncs upstream `main` every 6 hours and merges into all `skill/*` branches. Validates build and tests before pushing. Creates GitHub issues on sync failures.

---

## Setup

Same as upstream:

```bash
git clone https://github.com/david-gonzalez-pnw/nanoclaw.git
cd nanoclaw
claude
```

Then run `/setup`.

### Additional Configuration

This fork reads plugin credentials from `~/.config/nanoclaw/`:

| File | Purpose |
|------|---------|
| `github-token` | GitHub PAT for the `gh` plugin |
| `gcp-service-account.json` | GCP service account for `gcloud` and `gcpLogging` plugins |
| `azure-sp.json` | Azure service principal credentials (`appId`, `password`, `tenant`, `subscriptionId`) for `azure` and `appInsights` plugins |
| `mount-allowlist.json` | Directories allowed to be mounted into containers |

See `.env.example` for all environment variables.

## License

MIT -- same as [upstream](https://github.com/qwibitai/nanoclaw/blob/main/LICENSE).
