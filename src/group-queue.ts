import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

/** Default slot key for non-threaded messages and tasks. */
export const DEFAULT_SLOT = '__default__';

/**
 * Per-thread (or default) container slot state.
 * Each slot independently tracks a container lifecycle.
 */
interface ThreadSlotState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

interface WaitingSlot {
  groupJid: string;
  slotKey: string;
}

export class GroupQueue {
  // Nested map: groupJid → (slotKey → ThreadSlotState)
  private groups = new Map<string, Map<string, ThreadSlotState>>();
  private activeCount = 0;
  private waitingSlots: WaitingSlot[] = [];
  private processMessagesFn:
    | ((groupJid: string, threadId?: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private getSlot(groupJid: string, slotKey: string): ThreadSlotState {
    let groupSlots = this.groups.get(groupJid);
    if (!groupSlots) {
      groupSlots = new Map();
      this.groups.set(groupJid, groupSlots);
    }
    let state = groupSlots.get(slotKey);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      groupSlots.set(slotKey, state);
    }
    return state;
  }

  private slotKey(threadId?: string): string {
    return threadId || DEFAULT_SLOT;
  }

  /** Compute the IPC input directory for a slot. */
  private ipcInputDir(groupFolder: string, threadId?: string): string {
    if (threadId) {
      return path.join(
        DATA_DIR,
        'ipc',
        groupFolder,
        'threads',
        threadId.replace(/\./g, '-'),
        'input',
      );
    }
    return path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  }

  setProcessMessagesFn(
    fn: (groupJid: string, threadId?: string) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string, threadId?: string): void {
    if (this.shuttingDown) return;

    const key = this.slotKey(threadId);
    const state = this.getSlot(groupJid, key);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug(
        { groupJid, threadId, slot: key },
        'Slot active, message queued',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      const alreadyWaiting = this.waitingSlots.some(
        (w) => w.groupJid === groupJid && w.slotKey === key,
      );
      if (!alreadyWaiting) {
        this.waitingSlots.push({ groupJid, slotKey: key });
      }
      logger.debug(
        { groupJid, threadId, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForSlot(groupJid, key, 'messages').catch((err) =>
      logger.error(
        { groupJid, threadId, err },
        'Unhandled error in runForSlot',
      ),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    // Tasks always use the default slot (no thread context)
    const state = this.getSlot(groupJid, DEFAULT_SLOT);

    // Prevent double-queuing
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Default slot active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      const alreadyWaiting = this.waitingSlots.some(
        (w) => w.groupJid === groupJid && w.slotKey === DEFAULT_SLOT,
      );
      if (!alreadyWaiting) {
        this.waitingSlots.push({ groupJid, slotKey: DEFAULT_SLOT });
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    threadId?: string,
  ): void {
    const state = this.getSlot(groupJid, this.slotKey(threadId));
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Get the active thread ID for a group.
   * Returns the first active non-default slot's threadId, or null.
   * Used by IPC/scheduler for backward compat when threadId isn't in the payload.
   */
  getActiveThreadId(groupJid: string): string | null {
    const groupSlots = this.groups.get(groupJid);
    if (!groupSlots) return null;
    for (const [slotKey, state] of groupSlots) {
      if (state.active && slotKey !== DEFAULT_SLOT) {
        return slotKey;
      }
    }
    return null;
  }

  /**
   * Mark a slot's container as idle-waiting.
   * If tasks are pending on the default slot, preempt it.
   */
  notifyIdle(groupJid: string, threadId?: string): void {
    const state = this.getSlot(groupJid, this.slotKey(threadId));
    state.idleWaiting = true;

    // Only the default slot handles tasks
    if (!threadId || threadId === DEFAULT_SLOT) {
      if (state.pendingTasks.length > 0) {
        this.closeStdin(groupJid);
      }
    }
  }

  /**
   * Send a follow-up message to the active container for a specific thread.
   * Returns true if the message was written, false if no matching active container.
   */
  sendMessage(groupJid: string, text: string, threadId?: string): boolean {
    const key = this.slotKey(threadId);
    const state = this.getSlot(groupJid, key);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;

    state.idleWaiting = false;

    const inputDir = this.ipcInputDir(state.groupFolder, threadId);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal a slot's container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, threadId?: string): void {
    const key = this.slotKey(threadId);
    const state = this.getSlot(groupJid, key);
    if (!state.active || !state.groupFolder) return;

    const inputDir = this.ipcInputDir(state.groupFolder, threadId);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForSlot(
    groupJid: string,
    slotKey: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getSlot(groupJid, slotKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    const threadId = slotKey !== DEFAULT_SLOT ? slotKey : undefined;

    logger.debug(
      { groupJid, slotKey, reason, activeCount: this.activeCount },
      'Starting container for slot',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, threadId);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, slotKey, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, slotKey, err }, 'Error processing messages');
      this.scheduleRetry(groupJid, slotKey, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainSlot(groupJid, slotKey);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getSlot(groupJid, DEFAULT_SLOT);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainSlot(groupJid, DEFAULT_SLOT);
    }
  }

  private scheduleRetry(
    groupJid: string,
    slotKey: string,
    state: ThreadSlotState,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, slotKey, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    const threadId = slotKey !== DEFAULT_SLOT ? slotKey : undefined;
    logger.info(
      { groupJid, slotKey, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid, threadId);
      }
    }, delayMs);
  }

  private drainSlot(groupJid: string, slotKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getSlot(groupJid, slotKey);

    // Tasks first (only on default slot)
    if (slotKey === DEFAULT_SLOT && state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages for this slot
    if (state.pendingMessages) {
      this.runForSlot(groupJid, slotKey, 'drain').catch((err) =>
        logger.error(
          { groupJid, slotKey, err },
          'Unhandled error in runForSlot (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this slot; check if other slots are waiting
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingSlots.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const next = this.waitingSlots.shift()!;
      const state = this.getSlot(next.groupJid, next.slotKey);

      // Prioritize tasks over messages (only on default slot)
      if (next.slotKey === DEFAULT_SLOT && state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(next.groupJid, task).catch((err) =>
          logger.error(
            { groupJid: next.groupJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForSlot(next.groupJid, next.slotKey, 'drain').catch((err) =>
          logger.error(
            { groupJid: next.groupJid, slotKey: next.slotKey, err },
            'Unhandled error in runForSlot (waiting)',
          ),
        );
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [_jid, groupSlots] of this.groups) {
      for (const [_slotKey, state] of groupSlots) {
        if (state.process && !state.process.killed && state.containerName) {
          activeContainers.push(state.containerName);
        }
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
