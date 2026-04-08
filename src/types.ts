export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  capabilities?: Partial<Record<PluginName, boolean>>; // Per-group plugin overrides
}

// --- Plugin capabilities ---

export type PluginName =
  | 'gcloud'
  | 'gcpLogging'
  | 'codeTasks'
  | 'worktrees'
  | 'gh'
  | 'azure'
  | 'appInsights';

export type CapabilitiesConfig = Record<PluginName, boolean>;

// --- Plugin system ---

export interface PluginPrerequisite {
  type: 'file' | 'env' | 'command';
  /** For 'file': path (supports ~). For 'env': var name. For 'command': binary name. */
  path: string;
  description: string;
}

export interface PluginMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  /** Only mount when this prerequisite is satisfied, e.g. "prerequisite:0" */
  condition?: string;
}

export interface PluginMcpServer {
  /** Relative path to compiled .js file inside agent-runner dist dir */
  scriptPath: string;
  env?: Record<string, string>;
}

export interface PluginContainerConfig {
  mounts: PluginMount[];
  envVars: Record<string, string>;
  entrypointCommands: string[];
  mcpServers: Record<string, PluginMcpServer>;
  allowedTools: string[];
  /** Skill directory names under container/skills/ to sync */
  skills: string[];
}

export interface PluginManifest {
  name: string;
  description: string;
  prerequisites: PluginPrerequisite[];
  container: PluginContainerConfig;
  /** Host-side behavioral toggles */
  hostBehavior?: {
    worktrees?: boolean;
  };
  setupInstructions: string;
}

export interface PluginStatus {
  name: string;
  enabled: boolean;
  ready: boolean;
  failedPrerequisites: Array<{
    index: number;
    prerequisite: PluginPrerequisite;
    reason: string;
  }>;
  setupInstructions: string;
}

export interface ResolvedPluginHooks {
  mounts: PluginMount[];
  envVars: Record<string, string>;
  entrypointCommands: string[];
  mcpServers: Record<string, PluginMcpServer>;
  allowedTools: string[];
  skills: string[];
  worktreesEnabled: boolean;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_ts?: string; // Thread parent timestamp (Slack threads)
}

export interface SendMessageOptions {
  threadId?: string; // Reply in-thread (e.g. Slack thread_ts)
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
