import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// Mock slackify-markdown — pass through text unchanged in tests
vi.mock('slackify-markdown', () => ({
  slackifyMarkdown: (text: string) => text,
}));

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    token: string;
    appToken: string;

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    assistant(_config: any) {}

    async start() {}
    async stop() {}
  },
  Assistant: class MockAssistant {
    constructor(_config: any) {}
  },
  LogLevel: { ERROR: 'error' },
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

// Mock transcription so the real sidecar client isn't loaded during tests.
// Tests override the return value per-case with transcribeAudioFileMock.
const transcribeAudioFileMock = vi.hoisted(() => vi.fn());
vi.mock('../transcription.js', () => ({
  transcribeAudioFile: transcribeAudioFileMock,
}));

// Mock group-folder so file download tests don't need a real group dir on disk
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

import fs from 'fs';

import { SlackChannel, SlackChannelOpts } from './slack.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  channelType?: string;
  user?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}) {
  return {
    channel: overrides.channel ?? 'C0123456789',
    channel_type: overrides.channelType ?? 'channel',
    user: overrides.user ?? 'U_USER_456',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    ts: overrides.ts ?? '1704067200.000000',
    thread_ts: overrides.threadTs,
    subtype: overrides.subtype,
    bot_id: overrides.botId,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessageEvent(
  event: ReturnType<typeof createMessageEvent>,
) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message event handler on construction', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C0123456789',
          sender: 'U_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ channel: 'C9999999999' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C9999999999',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text subtypes (channel_join, etc.)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ subtype: 'channel_join' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('allows bot_message subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_OTHER_BOT',
        text: 'Bot message',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: undefined as any });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by bot_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
        text: 'Bot response',
      });
      await triggerMessageEvent(event);

      // Has bot_id so should be marked as bot message
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by matching bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        user: 'U_BOT_123',
        text: 'Self message',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies IM channel type as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D0123456789': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'D0123456789',
        channelType: 'im',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D0123456789',
        expect.any(String),
        undefined,
        'slack',
        false, // IM is not a group
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ ts: '1704067200.000000' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('resolves user name from Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ user: 'U_USER_456', text: 'Hello' });
      await triggerMessageEvent(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_456',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'Alice Smith',
        }),
      );
    });

    it('caches user names to avoid repeated API calls', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First message — API call
      await triggerMessageEvent(
        createMessageEvent({ user: 'U_USER_456', text: 'First' }),
      );
      // Second message — should use cache
      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'Second',
          ts: '1704067201.000000',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });

    it('falls back to user ID when API fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ user: 'U_UNKNOWN', text: 'Hi' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'U_UNKNOWN',
        }),
      );
    });

    it('flattens threaded replies into channel messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000', // parent message ts — this is a reply
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      // Threaded replies are delivered as regular channel messages
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread reply',
        }),
      );
    });

    it('delivers thread parent messages normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000', // same as ts — this IS the parent
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread parent',
        }),
      );
    });

    it('delivers messages without thread_ts normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Normal message' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Slack format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      const event = createMessageEvent({
        text: 'Hey <@U_BOT_123> what do you think?',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy Hey <@U_BOT_123> what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Jonesy <@U_BOT_123> hello',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Content should be unchanged since it already matches TRIGGER_PATTERN
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Echo: <@U_BOT_123>',
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
      });
      await triggerMessageEvent(event);

      // Bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Echo: <@U_BOT_123>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hey <@U_OTHER_USER> look at this',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Mention is for a different user, not the bot
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Hey <@U_OTHER_USER> look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Slack client', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:D9876543210', 'DM message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D9876543210',
        text: 'DM message',
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage('slack:C0123456789', 'Queued message');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C0123456789', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 3000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Create a message longer than 3000 chars
      const longText = 'A'.repeat(3500);
      await channel.sendMessage('slack:C0123456789', longText);

      // Should be split into 2 messages: 3000 + 500
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C0123456789',
        text: 'A'.repeat(3000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C0123456789',
        text: 'A'.repeat(500),
      });
    });

    it('sends exactly-3000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(3000);
      await channel.sendMessage('slack:C0123456789', text);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text,
      });
    });

    it('splits messages into 3 parts when over 6000 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'C'.repeat(6500);
      await channel.sendMessage('slack:C0123456789', longText);

      // 3000 + 3000 + 500 = 3 messages
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(3);
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'First queued');
      await channel.sendMessage('slack:C0123456789', 'Second queued');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'First queued',
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Second queued',
      });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(true);
    });

    it('owns slack: DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChannelMetadata ---

  describe('syncChannelMetadata', () => {
    it('calls conversations.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'general', is_member: true },
          { id: 'C002', name: 'random', is_member: true },
          { id: 'C003', name: 'external', is_member: false },
        ],
        response_metadata: {},
      });

      await channel.connect();

      // connect() calls syncChannelMetadata internally
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
      // Non-member channels are skipped
      expect(updateChatName).not.toHaveBeenCalledWith('slack:C003', 'external');
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.connect()).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Should not throw — Slack has no bot typing indicator API
      await expect(
        channel.setTyping('slack:C0123456789', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await expect(
        channel.setTyping('slack:C0123456789', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when SLACK_BOT_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: '',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });

    it('throws when SLACK_APP_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: '',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  // --- syncChannelMetadata pagination ---

  describe('syncChannelMetadata pagination', () => {
    it('paginates through multiple pages of channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First page returns a cursor; second page returns no cursor
      currentApp()
        .client.conversations.list.mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'general', is_member: true }],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'random', is_member: true }],
          response_metadata: {},
        });

      await channel.connect();

      // Should have called conversations.list twice (once per page)
      expect(currentApp().client.conversations.list).toHaveBeenCalledTimes(2);
      expect(currentApp().client.conversations.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor_page2' }),
      );

      // Both channels from both pages stored
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
    });
  });

  // --- File attachments (images / audio / docs) ---

  describe('file attachments', () => {
    let mkdirSpy: any;
    let writeSpy: any;
    let fetchSpy: any;

    beforeEach(() => {
      mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      writeSpy = vi
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(() => undefined);
      fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(Buffer.from('filebytes'), { status: 200 }) as any,
        );
      transcribeAudioFileMock.mockReset();
    });

    afterEach(() => {
      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    function fileShareEvent(files: any[], overrides: any = {}) {
      return {
        channel: 'C0123456789',
        channel_type: 'channel',
        user: 'U_USER_456',
        text: 'check this',
        ts: '1704067200.000000',
        subtype: 'file_share',
        files,
        ...overrides,
      };
    }

    it('embeds image files as [Attached image: ...] refs', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        fileShareEvent([
          {
            id: 'F1',
            name: 'photo.png',
            mimetype: 'image/png',
            size: 1024,
            url_private_download: 'https://slack/F1',
          },
        ]) as any,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Attached image: /workspace/group/uploads/slack-1704067200-000000-photo.png]',
          ),
        }),
      );
      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
    });

    it('transcribes audio and embeds as [Voice: ...]', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      transcribeAudioFileMock.mockResolvedValue({
        text: 'hello from the voice note',
        duration: 3.2,
        language: 'en',
      });

      const reactionsAdd = vi.fn().mockResolvedValue({});
      const reactionsRemove = vi.fn().mockResolvedValue({});
      currentApp().client.reactions = {
        add: reactionsAdd,
        remove: reactionsRemove,
      };

      await triggerMessageEvent(
        fileShareEvent([
          {
            id: 'F2',
            name: 'note.m4a',
            mimetype: 'audio/m4a',
            size: 2048,
            url_private_download: 'https://slack/F2',
          },
        ]) as any,
      );

      expect(transcribeAudioFileMock).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Voice: hello from the voice note]',
          ),
        }),
      );
      // :ear: reaction bracketed the transcription
      expect(reactionsAdd).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ear' }),
      );
      expect(reactionsRemove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ear' }),
      );
    });

    it('falls back to unavailable marker when transcription returns null', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      transcribeAudioFileMock.mockResolvedValue(null);
      currentApp().client.reactions = {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      };

      await triggerMessageEvent(
        fileShareEvent([
          {
            id: 'F3',
            name: 'note.webm',
            mimetype: 'audio/webm',
            size: 4096,
            url_private_download: 'https://slack/F3',
          },
        ]) as any,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Voice Message — transcription unavailable]',
          ),
        }),
      );
    });

    it('embeds PDFs as [Attached file: ...] refs', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        fileShareEvent([
          {
            id: 'F4',
            name: 'doc.pdf',
            mimetype: 'application/pdf',
            size: 10000,
            url_private_download: 'https://slack/F4',
          },
        ]) as any,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Attached file: /workspace/group/uploads/slack-1704067200-000000-doc.pdf]',
          ),
        }),
      );
    });

    it('skips unsupported file types silently', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        fileShareEvent([
          {
            id: 'F5',
            name: 'archive.zip',
            mimetype: 'application/zip',
            size: 500,
            url_private_download: 'https://slack/F5',
          },
        ]) as any,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({ content: 'check this' }),
      );
      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
    });

    it('does not add :ear: reaction when only images are attached', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const reactionsAdd = vi.fn().mockResolvedValue({});
      currentApp().client.reactions = {
        add: reactionsAdd,
        remove: vi.fn().mockResolvedValue({}),
      };

      await triggerMessageEvent(
        fileShareEvent([
          {
            id: 'F6',
            name: 'pic.jpg',
            mimetype: 'image/jpeg',
            size: 1024,
            url_private_download: 'https://slack/F6',
          },
        ]) as any,
      );

      expect(reactionsAdd).not.toHaveBeenCalled();
    });

    it('skips audio over the size cap', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.reactions = {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      };

      await triggerMessageEvent(
        fileShareEvent([
          {
            id: 'F7',
            name: 'huge.mp3',
            mimetype: 'audio/mpeg',
            size: 600 * 1024 * 1024, // above MAX_AUDIO_SIZE (500MB)
            url_private_download: 'https://slack/F7',
          },
        ]) as any,
      );

      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // --- Auto-register on bot join ---

  describe('auto-register on bot join', () => {
    function setupJoinApp(app: any) {
      app.client.conversations.info = vi.fn().mockResolvedValue({
        channel: { name: 'new-channel' },
      });
      app.client.conversations.history = vi
        .fn()
        .mockResolvedValue({ messages: [] });
    }

    it('registers the channel when the bot itself joins', async () => {
      const onRegisterGroup = vi.fn();
      const opts = createTestOpts({ onRegisterGroup });
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      setupJoinApp(currentApp());

      const handler = currentApp().eventHandlers.get('member_joined_channel');
      expect(handler).toBeDefined();
      await handler!({
        event: { user: 'U_BOT_123', channel: 'C_NEW_999' },
      });

      expect(onRegisterGroup).toHaveBeenCalledWith(
        'slack:C_NEW_999',
        expect.objectContaining({
          name: 'new-channel',
          folder: 'slack_new-channel',
          requiresTrigger: true,
        }),
      );
    });

    it('ignores joins by other users', async () => {
      const onRegisterGroup = vi.fn();
      const opts = createTestOpts({ onRegisterGroup });
      const channel = new SlackChannel(opts);
      await channel.connect();

      setupJoinApp(currentApp());

      const handler = currentApp().eventHandlers.get('member_joined_channel');
      await handler!({
        event: { user: 'U_SOMEONE_ELSE', channel: 'C_NEW_999' },
      });

      expect(onRegisterGroup).not.toHaveBeenCalled();
    });

    it('backfills recent history on auto-register', async () => {
      const onMessage = vi.fn();
      const onRegisterGroup = vi.fn();
      const opts = createTestOpts({ onMessage, onRegisterGroup });
      const channel = new SlackChannel(opts);
      await channel.connect();

      setupJoinApp(currentApp());
      // Slack's conversations.history returns newest-first; the handler
      // reverses into chronological order before forwarding to onMessage.
      currentApp().client.conversations.history = vi.fn().mockResolvedValue({
        messages: [
          { ts: '1704067201.000001', user: 'U_USER', text: 'newer' },
          { ts: '1704067200.000001', user: 'U_USER', text: 'older' },
        ],
      });

      const handler = currentApp().eventHandlers.get('member_joined_channel');
      await handler!({
        event: { user: 'U_BOT_123', channel: 'C_NEW_999' },
      });

      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(onMessage).toHaveBeenNthCalledWith(
        1,
        'slack:C_NEW_999',
        expect.objectContaining({ content: 'older' }),
      );
      expect(onMessage).toHaveBeenNthCalledWith(
        2,
        'slack:C_NEW_999',
        expect.objectContaining({ content: 'newer' }),
      );
    });

    it('does not re-register an already-registered channel', async () => {
      const onRegisterGroup = vi.fn();
      const opts = createTestOpts({
        onRegisterGroup,
        registeredGroups: vi.fn(() => ({
          'slack:C_NEW_999': {
            name: 'already-registered',
            folder: 'slack_already-registered',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      setupJoinApp(currentApp());

      const handler = currentApp().eventHandlers.get('member_joined_channel');
      await handler!({
        event: { user: 'U_BOT_123', channel: 'C_NEW_999' },
      });

      expect(onRegisterGroup).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });
});
