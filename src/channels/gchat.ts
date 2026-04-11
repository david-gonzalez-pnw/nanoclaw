/**
 * Google Chat channel for NanoClaw.
 * Connects to a local GWS Chat MCP server via SSE to poll for inbound
 * messages and send outbound replies.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { getRouterState, setRouterState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { formatForChannel } from '../formatter.js';
import { Channel, NewMessage, SendMessageOptions } from '../types.js';

const POLL_CURSOR_KEY_PREFIX = 'gchat:poll_cursor:';

// How often to poll for new messages (ms)
const POLL_INTERVAL = 3000;

// Max messages per poll
const POLL_PAGE_SIZE = 25;

// Default SSE endpoint for the GWS Chat MCP server
const DEFAULT_MCP_URL = 'http://localhost:3900/sse';

interface GChatMessage {
  name: string; // e.g. "spaces/ABC/messages/XYZ"
  sender: {
    name: string; // e.g. "users/12345"
    displayName: string;
    type: string; // "HUMAN" or "BOT"
  };
  text: string;
  createTime: string; // ISO timestamp
  thread?: {
    name: string; // thread resource name
    threadKey?: string;
  };
  space: {
    name: string;
    displayName?: string;
    type: string; // "ROOM", "DM", "SPACE"
  };
}

interface GChatSpace {
  name: string; // e.g. "spaces/ABC123"
  displayName?: string;
  type: string; // "ROOM", "DM", "SPACE"
}

export class GChatChannel implements Channel {
  readonly name = 'gchat';
  readonly formattingSpec = `Convert standard Markdown to Google Chat format:
- Bold: **text** → *text*
- Italic: *text* → _text_
- Strikethrough: ~~text~~ → ~text~
- Inline code and code blocks: unchanged
- Links: [text](url) → just paste the raw URL on its own line
- Headers: # text → *text* (bold, no header syntax)
- Horizontal rules: --- → (remove entirely)`;

  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTimestamps = new Map<string, string>();
  private connectTimestamp: string | null = null;
  // Message IDs we sent ourselves — used to skip them when polling, since
  // the MCP server is authenticated AS the user, so outbound messages come
  // back via the poller looking like regular human messages.
  private sentMessageIds = new Set<string>();
  private selfUserId: string | null = null;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    threadKey?: string;
  }> = [];
  private mcpUrl: string;

  constructor(
    private opts: ChannelOpts,
    mcpUrl?: string,
  ) {
    this.mcpUrl = mcpUrl || DEFAULT_MCP_URL;
  }

  async connect(): Promise<void> {
    try {
      this.transport = new SSEClientTransport(new URL(this.mcpUrl));
      this.client = new Client(
        { name: 'nanoclaw-gchat', version: '1.0.0' },
        { capabilities: {} },
      );

      await this.client.connect(this.transport);
      logger.info({ url: this.mcpUrl }, 'Connected to GChat MCP server');

      // Look back 15 minutes on connect so messages arriving during
      // downtime or restarts are not missed.
      this.connectTimestamp = new Date(
        Date.now() - 15 * 60 * 1000,
      ).toISOString();

      // Try to identify self by checking profile/membership later
      this.connected = true;

      // Flush queued messages
      await this.flushOutgoingQueue();

      // Sync space metadata on startup
      await this.syncGroups(true);

      // Start polling for messages
      this.pollTimer = setInterval(() => this.pollMessages(), POLL_INTERVAL);
    } catch (err) {
      logger.error({ err, url: this.mcpUrl }, 'Failed to connect to GChat MCP');
      throw err;
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    text = await formatForChannel(text, this.formattingSpec);
    const spaceName = jid.replace(/^gchat:/, '');
    const threadKey = options?.threadId;

    if (!this.connected || !this.client) {
      this.outgoingQueue.push({ jid, text, threadKey });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'GChat disconnected, message queued',
      );
      return;
    }

    try {
      const args: Record<string, string> = { space: spaceName, text };
      if (threadKey) {
        args.threadKey = threadKey;
      }

      const result = await this.client.callTool({
        name: 'chat_send_message',
        arguments: args,
      });
      const sentId = this.extractMessageId(result);
      if (sentId) {
        this.sentMessageIds.add(sentId);
        // Bound the set so it doesn't grow forever
        if (this.sentMessageIds.size > 500) {
          const first = this.sentMessageIds.values().next().value;
          if (first) this.sentMessageIds.delete(first);
        }
      }
      logger.info(
        { jid, length: text.length, threadKey, sentId },
        'GChat message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadKey });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send GChat message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gchat:');
  }

  /**
   * GChat has no native typing indicator API, so we post a one-shot
   * "noodling" placeholder message in the thread when work begins.
   * The actual response message follows separately when the agent finishes.
   */
  async setTyping(
    jid: string,
    isTyping: boolean,
    threadId?: string,
  ): Promise<void> {
    if (!isTyping || !this.connected || !this.client) return;
    const spaceName = jid.replace(/^gchat:/, '');
    try {
      const args: Record<string, string> = {
        space: spaceName,
        text: '💭 Noodling…',
      };
      if (threadId) args.threadKey = threadId;
      const result = await this.client.callTool({
        name: 'chat_send_message',
        arguments: args,
      });
      const sentId = this.extractMessageId(result);
      if (sentId) this.sentMessageIds.add(sentId);
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to post GChat noodling placeholder');
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.client = null;
  }

  async syncGroups(force: boolean): Promise<void> {
    if (!this.client || (!force && !this.connected)) return;

    try {
      const result = await this.client.callTool({
        name: 'chat_list_spaces',
        arguments: { pageSize: 100 },
      });

      const spaces = this.parseToolResult(result) as GChatSpace[];
      if (!Array.isArray(spaces)) {
        logger.warn({ result }, 'GChat list_spaces returned unexpected format');
        return;
      }

      for (const space of spaces) {
        const jid = `gchat:${space.name}`;
        const isGroup = space.type !== 'DM';
        this.opts.onChatMetadata(
          jid,
          new Date().toISOString(),
          space.displayName || space.name,
          'gchat',
          isGroup,
        );
      }

      logger.info({ count: spaces.length }, 'GChat spaces synced');
    } catch (err) {
      logger.warn({ err }, 'Failed to sync GChat spaces');
    }
  }

  /**
   * Fetch the full thread context (parent message + replies) from GChat API.
   * Thread name format: spaces/{SPACE}/threads/{ID}
   * Parent message:     spaces/{SPACE}/messages/{ID}
   */
  async fetchThreadContext(
    jid: string,
    threadId: string,
  ): Promise<NewMessage[]> {
    if (!this.client || !this.connected) return [];

    const results: NewMessage[] = [];

    // Derive parent message name from thread name
    // threadId = "spaces/ABC/threads/XYZ" → parent = "spaces/ABC/messages/XYZ"
    const parentName = threadId.replace('/threads/', '/messages/');

    // Fetch the thread parent message
    try {
      const parentResult = await this.client.callTool({
        name: 'chat_get_message',
        arguments: { name: parentName },
      });
      const parent = this.parseToolResult(parentResult) as GChatMessage | null;
      if (parent && parent.text && parent.createTime) {
        const isBotMessage = parent.sender?.type === 'BOT';
        results.push({
          id: parent.name,
          chat_jid: jid,
          sender: parent.sender?.name || '',
          sender_name: isBotMessage
            ? parent.sender?.displayName || 'Bot'
            : parent.sender?.displayName || parent.sender?.name || 'unknown',
          content: parent.text,
          timestamp: parent.createTime,
          is_from_me: false,
          is_bot_message: isBotMessage,
          thread_ts: threadId,
        });
      }
    } catch (err) {
      logger.warn({ threadId, err }, 'Failed to fetch thread parent message');
    }

    // Fetch recent replies in the thread
    try {
      const spaceName = jid.replace(/^gchat:/, '');
      const repliesResult = await this.client.callTool({
        name: 'chat_list_messages',
        arguments: {
          space: spaceName,
          pageSize: '50',
          orderBy: 'createTime ASC',
        },
      });
      const allMessages = this.parseToolResult(repliesResult) as GChatMessage[];
      if (Array.isArray(allMessages)) {
        for (const msg of allMessages) {
          if (!msg.text || !msg.createTime) continue;
          // Filter to only messages in this thread
          if (msg.thread?.name !== threadId) continue;
          // Skip if already added (parent)
          if (msg.name === parentName) continue;

          const isBotMessage = msg.sender?.type === 'BOT';
          results.push({
            id: msg.name,
            chat_jid: jid,
            sender: msg.sender?.name || '',
            sender_name: isBotMessage
              ? msg.sender?.displayName || 'Bot'
              : msg.sender?.displayName || msg.sender?.name || 'unknown',
            content: msg.text,
            timestamp: msg.createTime,
            is_from_me: false,
            is_bot_message: isBotMessage,
            thread_ts: threadId,
          });
        }
      }
    } catch (err) {
      logger.warn({ threadId, err }, 'Failed to fetch thread replies');
    }

    // Sort chronologically
    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    logger.info(
      { threadId, messageCount: results.length },
      'Fetched thread context',
    );

    return results;
  }

  /**
   * Poll registered spaces for new messages.
   */
  private async pollMessages(): Promise<void> {
    if (!this.client || !this.connected) return;

    const groups = this.opts.registeredGroups();
    const gchatGroups = Object.entries(groups).filter(([jid]) =>
      jid.startsWith('gchat:'),
    );

    if (gchatGroups.length === 0) return;

    for (const [jid, _group] of gchatGroups) {
      try {
        await this.pollSpace(jid);
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to poll GChat space');
      }
    }
  }

  private async pollSpace(jid: string): Promise<void> {
    const spaceName = jid.replace(/^gchat:/, '');
    // Cursor lookup order:
    //   1. In-memory cursor (set after every successful poll)
    //   2. Persisted cursor (survives restarts so messages aren't lost during downtime)
    //   3. Connect time fallback for first-ever poll on a fresh install
    const lastTimestamp =
      this.lastPollTimestamps.get(jid) ||
      getRouterState(POLL_CURSOR_KEY_PREFIX + jid) ||
      this.connectTimestamp ||
      new Date().toISOString();

    const args: Record<string, unknown> = {
      space: spaceName,
      pageSize: POLL_PAGE_SIZE,
      orderBy: 'createTime ASC',
      filter: `createTime > "${lastTimestamp}"`,
    };

    const result = await this.client!.callTool({
      name: 'chat_list_messages',
      arguments: args as Record<string, string>,
    });

    const messages = this.parseToolResult(result) as GChatMessage[];
    if (!Array.isArray(messages) || messages.length === 0) return;

    let latestTimestamp = lastTimestamp;

    for (const msg of messages) {
      if (!msg.text || !msg.createTime) continue;

      const timestamp = msg.createTime;
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
      }

      // Skip messages we sent ourselves. The MCP server is authenticated as
      // the user, so outbound messages come back via the poller looking like
      // regular human messages — we have to track them by ID to avoid loops.
      if (msg.name && this.sentMessageIds.has(msg.name)) {
        continue;
      }

      // Detect self-messages (BOT type sender)
      const isBotMessage = msg.sender?.type === 'BOT';

      // Report metadata for every message (group discovery)
      this.opts.onChatMetadata(
        jid,
        timestamp,
        msg.space?.displayName,
        'gchat',
        msg.space?.type !== 'DM',
      );

      const senderName = isBotMessage
        ? ASSISTANT_NAME
        : msg.sender?.displayName || msg.sender?.name || 'unknown';

      let content = msg.text;

      // Translate @mentions of the assistant name into trigger pattern
      if (
        !isBotMessage &&
        content.toLowerCase().includes(ASSISTANT_NAME.toLowerCase()) &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Extract thread context
      const threadKey = msg.thread?.name || undefined;

      this.opts.onMessage(jid, {
        id: msg.name,
        chat_jid: jid,
        sender: msg.sender?.name || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        thread_ts: threadKey,
      });
    }

    this.lastPollTimestamps.set(jid, latestTimestamp);
    setRouterState(POLL_CURSOR_KEY_PREFIX + jid, latestTimestamp);
  }

  /**
   * Extract the message resource name from a chat_send_message result.
   */
  private extractMessageId(result: unknown): string | null {
    const parsed = this.parseToolResult(result) as {
      name?: string;
    } | null;
    return parsed && typeof parsed.name === 'string' ? parsed.name : null;
  }

  /**
   * Parse the MCP callTool result into structured data.
   * The result content can be text (JSON string) or structured.
   */
  private parseToolResult(result: unknown): unknown {
    const r = result as {
      content?: Array<{ type: string; text?: string }>;
    };
    if (!r?.content?.length) return [];

    const textContent = r.content.find((c) => c.type === 'text');
    if (!textContent?.text) return [];

    try {
      const parsed = JSON.parse(textContent.text);
      // Handle wrapped responses like { messages: [...] } or { spaces: [...] }
      if (parsed.messages) return parsed.messages;
      if (parsed.spaces) return parsed.spaces;
      if (Array.isArray(parsed)) return parsed;
      return parsed;
    } catch {
      return [];
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.outgoingQueue.length === 0) return;

    const queue = [...this.outgoingQueue];
    this.outgoingQueue = [];

    for (const item of queue) {
      try {
        const spaceName = item.jid.replace(/^gchat:/, '');
        const args: Record<string, string> = {
          space: spaceName,
          text: item.text,
        };
        if (item.threadKey) {
          args.threadKey = item.threadKey;
        }
        const result = await this.client!.callTool({
          name: 'chat_send_message',
          arguments: args,
        });
        const sentId = this.extractMessageId(result);
        if (sentId) this.sentMessageIds.add(sentId);
        logger.info({ jid: item.jid, sentId }, 'Queued GChat message sent');
      } catch (err) {
        logger.warn(
          { jid: item.jid, err },
          'Failed to send queued GChat message',
        );
        this.outgoingQueue.push(item);
      }
    }
  }
}

registerChannel('gchat', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['GCHAT_MCP_URL']);
  if (!envVars.GCHAT_MCP_URL) {
    logger.warn('GChat: GCHAT_MCP_URL not set in .env');
    return null;
  }
  return new GChatChannel(opts, envVars.GCHAT_MCP_URL);
});
