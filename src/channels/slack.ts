import { App, Assistant, LogLevel } from '@slack/bolt';
import type {
  GenericMessageEvent,
  BotMessageEvent,
  FileShareMessageEvent,
} from '@slack/types';
import fs from 'fs';
import path from 'path';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { createTranscriptionJob, updateChatName } from '../db.js';
import { formatForChannel } from '../formatter.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOptions,
} from '../types.js';

// Slack's section/text limits are officially 3000 chars; we chunk below that
// to leave headroom for trailing mrkdwn sigils and avoid msg_too_long errors
// that have bitten us at 4000.
const MAX_MESSAGE_LENGTH = 3000;
// Hard cap on total chunks per response. Anything beyond this is truncated with
// an explicit "truncated" footer — silently dropping a 50k response is worse
// than a visible cap. 10 × 3000 = 30k chars, more than enough for any sane reply.
const MAX_TOTAL_CHUNKS = 10;
const TRUNCATION_SUFFIX =
  '\n\n_…response truncated; see host logs for full output._';

// Supported MIME types by category. Each category has its own delivery path:
//   IMAGE — downloaded, path embedded as [Attached image: ...] for the agent's Read tool
//   AUDIO — downloaded, transcribed by the sidecar, text embedded as [Voice: ...]
//   DOC   — downloaded, path embedded as [Attached file: ...] for the agent's Read tool
const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const AUDIO_MIME_PREFIXES = ['audio/'];
const DOC_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
]);

// Per-category size caps
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_AUDIO_SIZE = 500 * 1024 * 1024; // sidecar caps compute time, not download
const MAX_DOC_SIZE = 25 * 1024 * 1024;

type SlackFile = {
  id: string;
  name: string | null;
  mimetype: string;
  size: number;
  url_private_download?: string;
};

type FileCategory = 'image' | 'audio' | 'doc' | 'unsupported';

interface DownloadedAttachment {
  category: 'image' | 'audio' | 'doc';
  hostPath: string;
  filename: string;
  containerPath: string;
  originalName: string | null;
  fileBytes: number;
}

function categorize(mime: string): FileCategory {
  if (IMAGE_MIME_TYPES.has(mime)) return 'image';
  if (AUDIO_MIME_PREFIXES.some((p) => mime.startsWith(p))) return 'audio';
  if (DOC_MIME_TYPES.has(mime)) return 'doc';
  return 'unsupported';
}

/**
 * Local regex-based markdown → Slack mrkdwn conversion. Safety net for when
 * the Ollama formatter is unavailable; also idempotent so it's cheap to run
 * as a final pass even after Ollama succeeds. Splits code blocks out so
 * their contents are preserved verbatim.
 */
function toSlackMrkdwnLocal(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code block — leave untouched
      return part
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*') // **bold** → *bold*
        .replace(/__([^_\n]+)__/g, '*$1*') // __bold__ → *bold*
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '_$1_') // *italic* → _italic_
        .replace(/~~([^~\n]+)~~/g, '~$1~') // ~~strike~~ → ~strike~
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*') // headers → bold
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>') // [t](u) → <u|t>
        .replace(/^(\s*)[-*+]\s+/gm, '$1• '); // - / * / + bullets → •
    })
    .join('');
}

function isSlackMsgTooLongError(err: unknown): boolean {
  const anyErr = err as
    | {
        data?: { error?: string };
        code?: string;
      }
    | undefined;
  return (
    anyErr?.data?.error === 'msg_too_long' ||
    (anyErr?.code === 'slack_webapi_platform_error' &&
      anyErr?.data?.error === 'msg_too_long')
  );
}

function applyTruncation(text: string): string {
  const maxTotal =
    MAX_MESSAGE_LENGTH * MAX_TOTAL_CHUNKS - TRUNCATION_SUFFIX.length;
  if (text.length <= MAX_MESSAGE_LENGTH * MAX_TOTAL_CHUNKS) return text;
  return text.slice(0, maxTotal) + TRUNCATION_SUFFIX;
}

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined), bot messages
// (BotMessageEvent, subtype 'bot_message'), and file shares (FileShareMessageEvent).
type HandledMessageEvent =
  | GenericMessageEvent
  | BotMessageEvent
  | FileShareMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';
  readonly formattingSpec = `Convert standard Markdown to Slack mrkdwn format:
- Bold: **text** → *text*
- Italic: *text* or _text_ → _text_
- Strikethrough: ~~text~~ → ~text~
- Inline code and code blocks: unchanged
- Links: [text](url) → <url|text>
- Bulleted lists: - item or * item → • item
- Headers: # text → *text* (bold, no header syntax in Slack)
- Blockquotes: > text → > text (unchanged)`;

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private botId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    threadTs?: string;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private assistantChannels = new Set<string>();
  // Placeholder messages: maps "channelId:threadTs" to the placeholder message ts.
  // Used to update "Processing..." messages with the actual response.
  private pendingPlaceholders = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Auto-register any channel the bot is invited to. Intent is clear: if
    // you add the bot to a channel, you want it to respond there. We also
    // back-fill recent history so messages sent in the gap between the invite
    // and the bot acknowledging it aren't silently dropped.
    this.app.event('member_joined_channel', async ({ event }) => {
      const joined = (event as { user?: string; channel?: string }).user;
      const channelId = (event as { user?: string; channel?: string }).channel;
      if (!channelId) return;
      if (!this.botUserId || joined !== this.botUserId) return;
      await this.autoRegisterChannel(channelId);
    });

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is GenericMessageEvent, BotMessageEvent, or FileShareMessageEvent
      const msg = event as HandledMessageEvent;

      // file_share messages may have empty text (image-only uploads)
      if (!msg.text && subtype !== 'file_share') return;

      // Capture thread context for replies.
      // For thread replies: thread_ts points to the parent message.
      // For top-level messages: thread_ts is absent or equals ts.
      // In both cases, we want responses to go to a thread — use the parent's ts
      // for replies, or the message's own ts for top-level messages (creates a new thread).
      const rawThreadTs = (msg as GenericMessageEvent).thread_ts;
      const threadTs =
        rawThreadTs && rawThreadTs !== msg.ts ? rawThreadTs : msg.ts;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage =
        !!(msg as BotMessageEvent).bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack bot mentions into TRIGGER_PATTERN format.
      // Slack usually encodes @mentions as <@U12345> (user ID), but can
      // intermittently use <@B12345> (bot ID) instead. Check both formats.
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const isBotMentioned =
          content.includes(`<@${this.botUserId}>`) ||
          (this.botId != null && content.includes(`<@${this.botId}>`));
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Post the "Finding answers..." placeholder BEFORE file download so the
      // user gets instant feedback. Audio transcription is now async (handled
      // by a background worker), so the placeholder + worker progress updates
      // keep the user informed while the sidecar grinds.
      const files = (msg as FileShareMessageEvent).files;
      const hasPlaceholderContent =
        content ||
        (files && !isBotMessage && files.some((f) => f.url_private_download));
      if (
        threadTs &&
        !isBotMessage &&
        hasPlaceholderContent &&
        TRIGGER_PATTERN.test((content || '').trim())
      ) {
        await this.backfillThreadHistory(msg.channel, threadTs, jid);
        await this.postPlaceholder(msg.channel, threadTs);
      }

      // Download attachments. Images/docs are appended to content now; audio
      // files are handed to the async transcription worker (this handler does
      // NOT await transcription).
      let deferredByTranscription = false;
      if (files && !isBotMessage) {
        const group = groups[jid];
        if (group) {
          const attachments = await this.downloadSlackFiles(
            files,
            group.folder,
            msg.ts,
          );
          const syncRefs: string[] = [];
          const audioAttachments: DownloadedAttachment[] = [];
          for (const att of attachments) {
            if (att.category === 'image') {
              syncRefs.push(`[Attached image: ${att.containerPath}]`);
            } else if (att.category === 'doc') {
              syncRefs.push(`[Attached file: ${att.containerPath}]`);
            } else {
              audioAttachments.push(att);
            }
          }
          if (syncRefs.length > 0) {
            const joined = syncRefs.join('\n');
            content = content ? `${content}\n${joined}` : joined;
          }
          for (const att of audioAttachments) {
            try {
              const jobId = createTranscriptionJob({
                chat_jid: jid,
                message_ts: msg.ts,
                thread_ts: threadTs || null,
                channel_id: msg.channel,
                file_host_path: att.hostPath,
                file_name: att.originalName,
                file_bytes: att.fileBytes,
                original_text: content,
                sender: msg.user || (msg as BotMessageEvent).bot_id || '',
                sender_name: senderName,
                timestamp_iso: timestamp,
              });
              deferredByTranscription = true;
              logger.info(
                {
                  jobId,
                  jid,
                  fileName: att.originalName,
                  bytes: att.fileBytes,
                },
                'Transcription job enqueued',
              );
            } catch (err) {
              logger.error(
                { err, jid, fileName: att.originalName },
                'Failed to enqueue transcription job',
              );
            }
          }
        }
      }

      // Audio was queued — the worker will inject the synthesized message
      // (with [Voice: …] appended) when transcription finishes. Nothing more
      // to do here.
      if (deferredByTranscription) return;

      // Skip messages with no content after processing (e.g. unsupported file types only)
      if (!content) return;

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || (msg as BotMessageEvent).bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        thread_ts: threadTs,
      });
    });

    // Slack Assistant API — provides a dedicated 1:1 assistant panel
    // with "thinking" indicator, suggested prompts, and no trigger word needed.
    const assistant = new Assistant({
      threadStarted: async ({ say, setSuggestedPrompts }) => {
        await say(`Hi! I'm ${ASSISTANT_NAME}. How can I help?`);
        await setSuggestedPrompts({
          prompts: [
            {
              title: 'Review code',
              message: 'Review the latest changes in the current branch',
            },
            { title: 'Fix a bug', message: 'Help me debug an issue' },
            {
              title: 'Write tests',
              message: 'Write tests for the recent changes',
            },
          ],
        });
      },

      userMessage: async ({ event, setStatus }) => {
        // Cast to GenericMessageEvent — assistant userMessage events are always
        // regular user messages in a DM thread
        const msg = event as GenericMessageEvent;
        const channelId = msg.channel;
        const threadTs = msg.thread_ts;
        const jid = `slack:${channelId}`;
        const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();

        // Track this as an assistant DM channel
        this.assistantChannels.add(channelId);

        // Auto-register if not in registeredGroups
        this.ensureAssistantGroupRegistered(jid);

        // Show "thinking" indicator (clears automatically when a message is posted)
        await setStatus('is thinking...');

        // Resolve sender name
        const senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';

        // Auto-prepend trigger — assistant messages are always directed at the bot
        let content = `@${ASSISTANT_NAME} ${msg.text || ''}`;

        // Download attached files. Images/docs are rendered inline; audio
        // files are enqueued for async transcription and the message is
        // deferred until the worker injects the transcribed version.
        let deferredByTranscription = false;
        const files = (msg as unknown as FileShareMessageEvent).files;
        if (files) {
          const groups = this.opts.registeredGroups();
          const group = groups[jid];
          if (group) {
            const attachments = await this.downloadSlackFiles(
              files,
              group.folder,
              msg.ts,
            );
            const syncRefs: string[] = [];
            const audioAttachments: DownloadedAttachment[] = [];
            for (const att of attachments) {
              if (att.category === 'image') {
                syncRefs.push(`[Attached image: ${att.containerPath}]`);
              } else if (att.category === 'doc') {
                syncRefs.push(`[Attached file: ${att.containerPath}]`);
              } else {
                audioAttachments.push(att);
              }
            }
            if (syncRefs.length > 0) {
              content = `${content}\n${syncRefs.join('\n')}`;
            }
            for (const att of audioAttachments) {
              try {
                const jobId = createTranscriptionJob({
                  chat_jid: jid,
                  message_ts: msg.ts,
                  thread_ts: threadTs || null,
                  channel_id: msg.channel,
                  file_host_path: att.hostPath,
                  file_name: att.originalName,
                  file_bytes: att.fileBytes,
                  original_text: content,
                  sender: msg.user || '',
                  sender_name: senderName,
                  timestamp_iso: timestamp,
                });
                deferredByTranscription = true;
                logger.info(
                  {
                    jobId,
                    jid,
                    fileName: att.originalName,
                    bytes: att.fileBytes,
                  },
                  'Transcription job enqueued (assistant DM)',
                );
              } catch (err) {
                logger.error(
                  { err, jid, fileName: att.originalName },
                  'Failed to enqueue transcription job (assistant DM)',
                );
              }
            }
          }
        }

        this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', false);

        // If audio was queued, the worker will inject the synthesized message.
        if (deferredByTranscription) return;

        this.opts.onMessage(jid, {
          id: msg.ts,
          chat_jid: jid,
          sender: msg.user || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
          thread_ts: threadTs,
        });
      },
    });

    this.app.assistant(assistant);
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botId = auth.bot_id as string | undefined;
      logger.info(
        { botUserId: this.botUserId, botId: this.botId },
        'Connected to Slack',
      );
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = options?.threadId;
    // Primary pass: Ollama-based converter. Safety net: local regex-based
    // mrkdwn conversion so Ollama outages don't leak raw markdown into Slack.
    text = await formatForChannel(text, this.formattingSpec);
    text = toSlackMrkdwnLocal(text);
    // Hard cap total length — a silent 50k-char reply is worse than a visible
    // truncation, since Slack will reject oversized payloads anyway.
    const originalLength = text.length;
    text = applyTruncation(text);
    if (text.length !== originalLength) {
      logger.warn(
        { jid, originalLength, truncatedTo: text.length },
        'Slack outbound message truncated (exceeded MAX_TOTAL_CHUNKS)',
      );
    }

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Check for a pending placeholder to update instead of posting a new message
      const placeholderKey = threadTs ? `${channelId}:${threadTs}` : null;
      const placeholderTs = placeholderKey
        ? this.pendingPlaceholders.get(placeholderKey)
        : null;

      if (placeholderTs) {
        // Update the "Finding answers..." placeholder with the actual response
        this.pendingPlaceholders.delete(placeholderKey!);
        const firstChunk = text.slice(0, MAX_MESSAGE_LENGTH);
        await this.app.client.chat.update({
          channel: channelId,
          ts: placeholderTs,
          text: firstChunk,
        });
        // Post remaining chunks as new messages in the thread
        if (text.length > MAX_MESSAGE_LENGTH) {
          for (
            let i = MAX_MESSAGE_LENGTH;
            i < text.length;
            i += MAX_MESSAGE_LENGTH
          ) {
            await this.app.client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs!,
              text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            });
          }
        }
      } else {
        // Normal send — no placeholder
        const postOpts = threadTs
          ? { channel: channelId, text, thread_ts: threadTs }
          : { channel: channelId, text };
        if (text.length <= MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage(postOpts);
        } else {
          for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
            await this.app.client.chat.postMessage({
              ...postOpts,
              text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            });
          }
        }
      }
      logger.info(
        { jid, length: text.length, threadTs, updated: !!placeholderTs },
        'Slack message sent',
      );
    } catch (err) {
      if (isSlackMsgTooLongError(err)) {
        // Content is too big for Slack regardless of retries — surface a
        // user-visible error instead of requeueing an unsendable payload.
        logger.error(
          { jid, length: text.length, err },
          'Slack rejected message (msg_too_long); posting fallback notice',
        );
        await this.postErrorFallback(channelId, threadTs, text.length);
        return;
      }
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  /**
   * When a response is unsendable (msg_too_long), update the placeholder (if
   * any) with a short notice so the user isn't stuck looking at "Finding
   * answers..." forever. Errors here are swallowed — there's nothing more to do.
   */
  private async postErrorFallback(
    channelId: string,
    threadTs: string | undefined,
    originalLength: number,
  ): Promise<void> {
    const notice = `⚠️ My reply was too large for Slack to accept (${originalLength} chars). Full output is in the host logs.`;
    const placeholderKey = threadTs ? `${channelId}:${threadTs}` : null;
    const placeholderTs = placeholderKey
      ? this.pendingPlaceholders.get(placeholderKey)
      : null;
    try {
      if (placeholderTs) {
        this.pendingPlaceholders.delete(placeholderKey!);
        await this.app.client.chat.update({
          channel: channelId,
          ts: placeholderTs,
          text: notice,
        });
      } else {
        const opts = threadTs
          ? { channel: channelId, text: notice, thread_ts: threadTs }
          : { channel: channelId, text: notice };
        await this.app.client.chat.postMessage(opts);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to post msg_too_long fallback notice');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Expose the underlying Bolt App so integrations can attach their own
   *  action/view/command handlers after connect(). */
  getApp(): App {
    return this.app;
  }

  /**
   * Update the "Finding answers..." placeholder with a transient status string
   * (used by the async transcription worker to show progress). No-op if the
   * thread has no tracked placeholder or the bot isn't connected.
   */
  async updatePlaceholder(
    jid: string,
    threadTs: string | null,
    text: string,
  ): Promise<void> {
    if (!threadTs || !this.connected) return;
    const channelId = jid.replace(/^slack:/, '');
    const placeholderKey = `${channelId}:${threadTs}`;
    const placeholderTs = this.pendingPlaceholders.get(placeholderKey);
    if (!placeholderTs) return;
    try {
      await this.app.client.chat.update({
        channel: channelId,
        ts: placeholderTs,
        text,
      });
    } catch (err) {
      logger.debug(
        { err, jid, threadTs },
        'Placeholder update from worker failed',
      );
    }
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Post a "Processing..." placeholder in a thread.
   * The first response will update this message instead of posting a new one.
   */
  private async postPlaceholder(
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Finding answers...',
      });
      if (result.ts) {
        this.pendingPlaceholders.set(`${channelId}:${threadTs}`, result.ts);
      }
    } catch (err) {
      logger.warn({ channelId, threadTs, err }, 'Failed to post placeholder');
    }
  }

  /**
   * Auto-register a regular Slack channel when the bot joins it.
   * Inherits container config from the first existing Slack group so repo
   * mounts carry over by default. Requires trigger by default; upgrade to
   * main via DB edit if desired.
   */
  private async autoRegisterChannel(channelId: string): Promise<void> {
    const jid = `slack:${channelId}`;
    const groups = this.opts.registeredGroups();
    if (groups[jid]) return;
    if (!this.opts.onRegisterGroup) return;

    let channelName = channelId;
    try {
      const info = await this.app.client.conversations.info({
        channel: channelId,
      });
      channelName =
        (info.channel as { name?: string } | undefined)?.name || channelId;
    } catch (err) {
      logger.warn(
        { err, channelId },
        'conversations.info failed during auto-register, using channel ID',
      );
    }

    // Inherit config from first Slack group (matches DM auto-register pattern)
    const slackGroup = Object.entries(groups).find(([k]) =>
      k.startsWith('slack:'),
    );
    const baseConfig = slackGroup?.[1]?.containerConfig;
    const folderName = `slack_${channelName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    this.opts.onRegisterGroup(jid, {
      name: channelName,
      folder: folderName,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: true,
      containerConfig: baseConfig,
    });
    updateChatName(jid, channelName);
    logger.info(
      { jid, name: channelName, folder: folderName },
      'Auto-registered channel on bot join',
    );

    await this.backfillChannelHistory(channelId, jid, 20);
  }

  /**
   * Pull the most recent `limit` messages from the channel into the pipeline,
   * so messages sent before auto-registration aren't lost. Each message is
   * delivered through onMessage as if it had arrived live — recovery picks
   * them up from the DB on the next message loop tick.
   */
  private async backfillChannelHistory(
    channelId: string,
    jid: string,
    limit: number,
  ): Promise<void> {
    try {
      const result = await this.app.client.conversations.history({
        channel: channelId,
        limit,
      });
      const messages = (result.messages || []).slice().reverse(); // oldest first
      for (const m of messages) {
        const rec = m as {
          ts?: string;
          user?: string;
          text?: string;
          subtype?: string;
          bot_id?: string;
          thread_ts?: string;
        };
        if (!rec.ts) continue;
        // Skip join/leave system messages and our own postings
        if (rec.subtype === 'channel_join' || rec.subtype === 'channel_leave')
          continue;
        const isBot = !!rec.bot_id || rec.user === this.botUserId;
        const senderName = isBot
          ? ASSISTANT_NAME
          : (rec.user ? await this.resolveUserName(rec.user) : undefined) ||
            rec.user ||
            'unknown';
        this.opts.onMessage(jid, {
          id: rec.ts,
          chat_jid: jid,
          sender: rec.user || rec.bot_id || '',
          sender_name: senderName,
          content: rec.text || '',
          timestamp: new Date(parseFloat(rec.ts) * 1000).toISOString(),
          is_from_me: isBot,
          is_bot_message: isBot,
          thread_ts: rec.thread_ts,
        });
      }
      logger.info(
        { channelId, count: messages.length },
        'Backfilled channel history on auto-register',
      );
    } catch (err) {
      logger.warn({ err, channelId }, 'Channel history backfill failed');
    }
  }

  /**
   * Auto-register an assistant DM channel as a group.
   * Inherits container config (repo mounts) from the first existing Slack group.
   * Uses a single shared folder so all assistant DMs share context/memory.
   */
  private ensureAssistantGroupRegistered(jid: string): void {
    const groups = this.opts.registeredGroups();
    if (groups[jid]) return;
    if (!this.opts.onRegisterGroup) return;

    // Find first Slack channel group to inherit config from
    const slackGroup = Object.entries(groups).find(
      ([key]) =>
        key.startsWith('slack:') &&
        !this.assistantChannels.has(key.replace('slack:', '')),
    );

    const baseConfig = slackGroup?.[1]?.containerConfig;

    this.opts.onRegisterGroup(jid, {
      name: 'assistant',
      folder: 'slack_assistant',
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      containerConfig: baseConfig,
    });

    logger.info({ jid }, 'Auto-registered assistant DM channel');
  }

  /**
   * Fetch full thread history from Slack and backfill messages NanoClaw hasn't seen.
   * Called when the bot is triggered in an existing thread, so the agent gets
   * the full conversation context — not just the triggering message.
   */
  private async backfillThreadHistory(
    channelId: string,
    threadTs: string,
    jid: string,
  ): Promise<void> {
    try {
      const result = await this.app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 100,
      });

      const messages = result.messages || [];
      if (messages.length <= 1) return; // Only the parent message, nothing to backfill

      let backfilled = 0;
      for (const reply of messages) {
        // Skip the current message (it will be stored by the caller)
        if (!reply.ts || !reply.text) continue;

        const isBotReply = !!reply.bot_id || reply.user === this.botUserId;
        const replyTimestamp = new Date(
          parseFloat(reply.ts) * 1000,
        ).toISOString();

        const senderName = isBotReply
          ? ASSISTANT_NAME
          : (reply.user ? await this.resolveUserName(reply.user) : undefined) ||
            reply.user ||
            'unknown';

        // Store via onMessage — the DB handles deduplication via PRIMARY KEY (id, chat_jid)
        this.opts.onMessage(jid, {
          id: reply.ts,
          chat_jid: jid,
          sender: reply.user || reply.bot_id || '',
          sender_name: senderName,
          content: reply.text,
          timestamp: replyTimestamp,
          is_from_me: isBotReply,
          is_bot_message: isBotReply,
          thread_ts:
            reply.thread_ts && reply.thread_ts !== reply.ts
              ? reply.thread_ts
              : undefined,
        });
        backfilled++;
      }

      if (backfilled > 0) {
        logger.info(
          { channelId, threadTs, backfilled },
          'Backfilled thread history from Slack',
        );
      }
    } catch (err) {
      logger.warn(
        { channelId, threadTs, err },
        'Failed to backfill thread history',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  /**
   * Download supported files from a Slack message and return typed metadata.
   * Callers decide what to do with each attachment: images/docs are rendered
   * inline; audio files get enqueued as async transcription jobs so the event
   * handler doesn't block.
   */
  private async downloadSlackFiles(
    files: SlackFile[],
    groupFolder: string,
    messageTs: string,
  ): Promise<DownloadedAttachment[]> {
    const withDownloadUrl = files.filter((f) => f.url_private_download);
    if (withDownloadUrl.length === 0) return [];

    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(groupFolder);
    } catch {
      return [];
    }

    const uploadsDir = path.join(groupDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });

    const results: DownloadedAttachment[] = [];
    const safeMsgTs = messageTs.replace(/\./g, '-');

    for (const file of withDownloadUrl) {
      const category = categorize(file.mimetype);
      if (category === 'unsupported') continue;

      const cap =
        category === 'image'
          ? MAX_IMAGE_SIZE
          : category === 'audio'
            ? MAX_AUDIO_SIZE
            : MAX_DOC_SIZE;
      if (file.size > cap) {
        logger.warn(
          { fileId: file.id, size: file.size, cap, category },
          'Slack attachment exceeds size cap, skipping',
        );
        continue;
      }

      const downloaded = await this.downloadOne(
        file,
        uploadsDir,
        safeMsgTs,
        category,
      );
      if (!downloaded) continue;

      const { hostPath, filename } = downloaded;
      results.push({
        category: category as 'image' | 'audio' | 'doc',
        hostPath,
        filename,
        containerPath: `/workspace/group/uploads/${filename}`,
        originalName: file.name,
        fileBytes: file.size,
      });
    }

    return results;
  }

  private async downloadOne(
    file: SlackFile,
    uploadsDir: string,
    safeMsgTs: string,
    category: FileCategory,
  ): Promise<{ hostPath: string; filename: string } | null> {
    try {
      const ext =
        file.name?.split('.').pop() || file.mimetype.split('/')[1] || 'bin';
      const fallback =
        category === 'image'
          ? `image.${ext}`
          : category === 'audio'
            ? `audio.${ext}`
            : `file.${ext}`;
      const safeName = (file.name || fallback)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 100);
      const filename = `slack-${safeMsgTs}-${safeName}`;
      const hostPath = path.join(uploadsDir, filename);

      const response = await fetch(file.url_private_download!, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });

      if (!response.ok) {
        logger.warn(
          { fileId: file.id, status: response.status },
          'Failed to download Slack file',
        );
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(hostPath, buffer);

      logger.info(
        { fileId: file.id, filename, size: buffer.length, category },
        'Downloaded Slack attachment',
      );
      return { hostPath, filename };
    } catch (err) {
      logger.warn({ fileId: file.id, err }, 'Error downloading Slack file');
      return null;
    }
  }

  private async addReaction(
    channelId: string,
    messageTs: string,
    name: string,
  ): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name,
      });
    } catch (err) {
      // already_reacted is fine; anything else we log quietly
      logger.debug({ err, name, messageTs }, 'reactions.add failed');
    }
  }

  private async removeReaction(
    channelId: string,
    messageTs: string,
    name: string,
  ): Promise<void> {
    try {
      await this.app.client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name,
      });
    } catch (err) {
      logger.debug({ err, name, messageTs }, 'reactions.remove failed');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        const postOpts = item.threadTs
          ? { channel: channelId, text: item.text, thread_ts: item.threadTs }
          : { channel: channelId, text: item.text };
        await this.app.client.chat.postMessage(postOpts);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
