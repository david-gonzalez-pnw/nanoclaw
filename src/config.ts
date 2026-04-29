import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CREDENTIAL_PROXY_PORT',
  'CONTAINER_ALIAS',
  'OLLAMA_URL',
  'OLLAMA_FORMATTER_MODEL',
  'TRANSCRIPTION_ENABLED',
  'TRANSCRIPTION_MODEL',
  'TRANSCRIPTION_DEVICE',
  'TRANSCRIPTION_PORT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_ALIAS =
  process.env.CONTAINER_ALIAS || envConfig.CONTAINER_ALIAS || '';
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;

// Transcription sidecar (Python + faster-whisper, keeps model resident in GPU)
export const TRANSCRIPTION_ENABLED =
  (process.env.TRANSCRIPTION_ENABLED || envConfig.TRANSCRIPTION_ENABLED) !==
  'false';
export const TRANSCRIPTION_PORT = parseInt(
  process.env.TRANSCRIPTION_PORT || envConfig.TRANSCRIPTION_PORT || '3003',
  10,
);
export const TRANSCRIPTION_MODEL =
  process.env.TRANSCRIPTION_MODEL ||
  envConfig.TRANSCRIPTION_MODEL ||
  'large-v3-turbo';
export const TRANSCRIPTION_DEVICE =
  process.env.TRANSCRIPTION_DEVICE || envConfig.TRANSCRIPTION_DEVICE || 'cuda';
// Max seconds to wait for the sidecar to become healthy after spawn.
// Model load is ~40s first time (GPU-resident after), +download on first ever run.
export const TRANSCRIPTION_STARTUP_TIMEOUT = parseInt(
  process.env.TRANSCRIPTION_STARTUP_TIMEOUT || '600000',
  10,
);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// GCP service account for gcloud CLI plugin (stored outside project root)
export const GCP_SERVICE_ACCOUNT_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'gcp-service-account.json',
);

// GCP service accounts for multi-environment Cloud Logging MCP
export const GCP_SA_PROD_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'nanoclaw-logs-reader-sa-prod.json',
);
export const GCP_SA_DEMO_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'nanoclaw-logs-reader-sa-demo.json',
);

// Default container config applied to ALL groups (merged with per-group overrides)
export const DEFAULT_CONTAINER_CONFIG_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'default-container-config.json',
);

// Ollama for channel-agnostic message formatting
export const OLLAMA_URL =
  process.env.OLLAMA_URL || envConfig.OLLAMA_URL || 'http://localhost:11434';
export const OLLAMA_FORMATTER_MODEL =
  process.env.OLLAMA_FORMATTER_MODEL ||
  envConfig.OLLAMA_FORMATTER_MODEL ||
  'qwen3.5';

// Worktree cleanup: stale worktrees older than this are removed
export const WORKTREE_MAX_AGE_MS = parseInt(
  process.env.WORKTREE_MAX_AGE_MS || String(24 * 60 * 60 * 1000),
  10,
); // 24 hours default
export const WORKTREE_CLEANUP_CRON =
  process.env.WORKTREE_CLEANUP_CRON || '0 3 * * *'; // daily at 3 AM
