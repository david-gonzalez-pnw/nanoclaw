/**
 * CLI channel — talk to your agent from a local terminal via Unix socket.
 *
 * Always-on, zero-credentials channel that ships with main. The daemon
 * listens on `data/cli.sock`; the `scripts/chat.ts` client connects, writes
 * a JSON line per message, reads JSON lines back. The channel plumbs into
 * the normal router/delivery path like any other adapter — `/clear` and
 * other session-level commands work identically.
 *
 * MVP shape:
 *   - One hardcoded messaging_group: `cli/local`. Wired to one agent via
 *     the setup flow (see `scripts/init-first-agent.ts`). Multi-agent
 *     support can add per-agent messaging_groups later without breaking
 *     the wire protocol.
 *   - Single connected client at a time. A second connection closes the
 *     first with a "superseded" notice.
 *   - Wire format: one JSON object per line.
 *       Client → server: { "text": "user message" }
 *       Server → client: { "text": "agent reply" }
 *   - deliver() silently no-ops when no client is connected. The outbound
 *     row is already in outbound.db, so the message isn't lost — it just
 *     doesn't reach this run's terminal. Reconnect to see subsequent replies.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PLATFORM_ID = 'local';

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;

  const adapter: ChannelAdapter = {
    name: 'cli',
    channelType: 'cli',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();

      // Stale socket cleanup: a previous run that crashed may have left the
      // file behind, and net.createServer refuses to bind to an existing path.
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          log.warn('Failed to unlink stale CLI socket (will try to bind anyway)', { sock, err });
        }
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          // Tighten perms so only the owner can connect. Unix socket files
          // obey filesystem perms — 0700 on the socket means other local
          // users can't send into this agent.
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
          }
          log.info('CLI channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.end();
        } catch {
          // swallow — teardown is best-effort
        }
        client = null;
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      // Remove the socket file so a relaunch doesn't trip over it.
      try {
        fs.unlinkSync(socketPath());
      } catch {
        // swallow
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      if (!client) {
        // No live terminal — outbound row is already persisted, so this
        // isn't a data loss. User will see it on the next connect cycle
        // (or never, if we don't add scroll-back). Not worth throwing.
        return undefined;
      }
      const text = extractText(message);
      if (text === null) return undefined;
      try {
        client.write(JSON.stringify({ text }) + '\n');
      } catch (err) {
        log.warn('Failed to write to CLI client', { err });
      }
      return undefined;
    },
  };

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    if (client) {
      try {
        client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
        client.end();
      } catch {
        // swallow
      }
    }
    client = socket;
    log.info('CLI client connected');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, config);
      }
    });

    socket.on('close', () => {
      if (client === socket) client = null;
      log.info('CLI client disconnected');
    });

    socket.on('error', (err) => {
      log.warn('CLI client socket error', { err });
    });
  }

  async function handleLine(line: string, config: ChannelSetup): Promise<void> {
    let payload: { text?: unknown };
    try {
      payload = JSON.parse(line);
    } catch (err) {
      log.warn('CLI: ignoring non-JSON line from client', { line });
      return;
    }
    if (typeof payload.text !== 'string' || payload.text.length === 0) return;

    const inbound: InboundMessage = {
      id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: {
        text: payload.text,
        sender: 'cli',
        senderId: `cli:${PLATFORM_ID}`,
      },
    };
    try {
      await config.onInbound(PLATFORM_ID, null, inbound);
    } catch (err) {
      log.error('CLI: onInbound threw', { err });
    }
  }

  return adapter;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('cli', { factory: createAdapter });
