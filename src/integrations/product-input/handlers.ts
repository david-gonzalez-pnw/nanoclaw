import type { App } from '@slack/bolt';

import { logger } from '../../logger.js';
import {
  deletePiSession,
  getPiPrState,
  insertAnswer,
  loadPiSession,
  resolveTiebreak,
  savePiSession,
  upsertPiPrState,
  type PiDecision,
  type PiSessionData,
} from './db.js';
import { fetchPIsForPR, type GithubClient } from './github.js';
import {
  buildAnswerSummaryText,
  buildCompletionModal,
  buildPIModal,
} from './slack-ui.js';
import {
  githubLoginForSlackUser,
  isTeamMember,
  SLACK_PI_CHANNEL,
} from './team.js';

export interface HandlerDeps {
  github: GithubClient;
  ensureScan: (prNumber: number, channelId: string) => Promise<string | null>;
}

export function registerHandlers(app: App, deps: HandlerDeps): void {
  // --- Button: "Answer questions" → open wizard modal ---
  app.action('pi_open_form', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions') return;
    const action = body.actions[0];
    if (action.type !== 'button') return;
    const prNumber = parseInt(action.value || '', 10);
    if (!prNumber) return;

    const userId = body.user.id;
    const channelId = body.channel?.id || SLACK_PI_CHANNEL;
    const triggerId = body.trigger_id;

    const message = (body as { message?: { ts?: string; thread_ts?: string } })
      .message;
    const anchorTs = message?.thread_ts || message?.ts;

    const pis = await fetchPIsForPR(deps.github, prNumber);
    if (!pis || pis.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `Could not load questions for PR #${prNumber}. The PR may have been updated.`,
      });
      return;
    }

    const sessionKey = `session:${userId}:${prNumber}`;
    let session = loadPiSession(sessionKey);
    if (!session) {
      session = {
        prNumber,
        userId,
        pis,
        currentIndex: 0,
        answers: {},
        startedAt: Date.now(),
        anchorTs,
        channelId,
      };
    } else {
      session.anchorTs = anchorTs || session.anchorTs;
      session.channelId = channelId;
    }
    savePiSession(sessionKey, session);

    try {
      await client.views.open({
        trigger_id: triggerId,
        view: buildPIModal({
          pi: session.pis[session.currentIndex],
          index: session.currentIndex,
          total: session.pis.length,
          prNumber,
          sessionKey,
        }),
      });
    } catch (err) {
      logger.error({ err, prNumber }, 'views.open failed for pi_open_form');
    }
  });

  // --- Button: "Resolve tie" → open tie-break modal ---
  app.action('pi_resolve_tie', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions') return;
    const action = body.actions[0];
    if (action.type !== 'button') return;

    let payload: { prNumber?: number; piKey?: string } = {};
    try {
      payload = JSON.parse(action.value || '{}');
    } catch {
      return;
    }
    const { prNumber, piKey } = payload;
    if (!prNumber || !piKey) return;

    const userId = body.user.id;
    if (!isTeamMember(userId)) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || SLACK_PI_CHANNEL,
        user: userId,
        text: 'Only team members can resolve tie-breaks.',
      });
      return;
    }

    const pis = await fetchPIsForPR(deps.github, prNumber);
    if (!pis) return;
    const pi = pis.find((p) => `${p.rfcName}:${p.id}` === piKey);
    if (!pi) return;

    const sessionKey = `tiebreak:${userId}:${prNumber}:${piKey}`;
    const message = (body as { message?: { ts?: string; thread_ts?: string } })
      .message;
    const anchorTs = message?.thread_ts || message?.ts;
    const session: PiSessionData = {
      prNumber,
      userId,
      pis: [pi],
      currentIndex: 0,
      answers: {},
      startedAt: Date.now(),
      anchorTs,
      channelId: body.channel?.id || SLACK_PI_CHANNEL,
      isTiebreak: true,
      tiebreakPiKey: piKey,
    };
    savePiSession(sessionKey, session);

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildPIModal({
          pi,
          index: 0,
          total: 1,
          prNumber,
          sessionKey,
          isTiebreak: true,
        }),
      });
    } catch (err) {
      logger.error(
        { err, prNumber, piKey },
        'views.open failed for pi_resolve_tie',
      );
    }
  });

  // --- View submission: wizard answer ---
  app.view('pi_answer_submit', async ({ ack, body, view, client }) => {
    let metadata: { sessionKey: string; piIndex: number };
    try {
      metadata = JSON.parse(view.private_metadata || '{}');
    } catch {
      await ack({ response_action: 'clear' });
      return;
    }

    const values = view.state.values as Record<
      string,
      Record<string, { selected_option?: { value?: string }; value?: string }>
    >;
    const decision = values.decision?.decision_value?.selected_option?.value as
      | PiDecision
      | undefined;
    const alternative = (
      values.alternative?.alternative_value?.value || ''
    ).trim();

    if (!decision) {
      await ack({
        response_action: 'errors',
        errors: { decision: 'Please select a decision.' },
      });
      return;
    }

    if (decision === 'override' && !alternative) {
      await ack({
        response_action: 'errors',
        errors: { alternative: 'Please describe your alternative answer.' },
      });
      return;
    }

    const session = loadPiSession(metadata.sessionKey);
    if (!session) {
      await ack({ response_action: 'clear' });
      return;
    }

    const pi = session.pis[metadata.piIndex];
    const piKey = `${pi.rfcName}:${pi.id}`;
    const answerText =
      decision === 'accept'
        ? pi.engRec
        : decision === 'override'
          ? alternative
          : 'flagged for discussion';

    session.answers[piKey] = {
      decision,
      piId: pi.id,
      rfcName: pi.rfcName,
      answer: answerText,
      reasoning: decision === 'override' ? alternative : null,
      answeredBy: body.user.id,
      answeredAt: Date.now(),
    };

    // Persist this single answer to pi_answers immediately.
    insertAnswer({
      pr_number: session.prNumber,
      pi_key: piKey,
      answered_by: body.user.id,
      decision,
      answer_text: answerText,
      reasoning: decision === 'override' ? alternative : null,
      github_login: githubLoginForSlackUser(body.user.id) || null,
      answered_at: Date.now(),
    });

    const nextIndex = metadata.piIndex + 1;
    if (nextIndex < session.pis.length) {
      session.currentIndex = nextIndex;
      savePiSession(metadata.sessionKey, session);
      await ack({
        response_action: 'update',
        view: buildPIModal({
          pi: session.pis[nextIndex],
          index: nextIndex,
          total: session.pis.length,
          prNumber: session.prNumber,
          sessionKey: metadata.sessionKey,
        }),
      });
      return;
    }

    session.completedAt = Date.now();
    savePiSession(metadata.sessionKey, session);

    const answeredCount = Object.values(session.answers).filter(
      (a) => a.decision !== 'discuss',
    ).length;
    const discussedCount = Object.values(session.answers).filter(
      (a) => a.decision === 'discuss',
    ).length;

    await ack({
      response_action: 'update',
      view: buildCompletionModal(
        session.prNumber,
        answeredCount,
        discussedCount,
      ),
    });

    // Post the answer summary in the PR's thread (bug fix: use session anchor first).
    const prState = getPiPrState(session.prNumber);
    const threadTs = session.anchorTs || prState?.thread_ts || undefined;
    const channelId = session.channelId || SLACK_PI_CHANNEL;
    try {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: buildAnswerSummaryText({
          prNumber: session.prNumber,
          userId: session.userId,
          pis: session.pis,
          answers: session.answers,
        }),
      });
    } catch (err) {
      logger.error(
        { err, prNumber: session.prNumber },
        'Failed to post answer summary',
      );
    }

    deletePiSession(metadata.sessionKey);
  });

  // --- View submission: tie-break resolution ---
  app.view('pi_tiebreak_submit', async ({ ack, body, view, client }) => {
    let metadata: { sessionKey: string; piIndex: number };
    try {
      metadata = JSON.parse(view.private_metadata || '{}');
    } catch {
      await ack({ response_action: 'clear' });
      return;
    }

    const values = view.state.values as Record<
      string,
      Record<string, { selected_option?: { value?: string }; value?: string }>
    >;
    const decision = values.decision?.decision_value?.selected_option?.value as
      | PiDecision
      | undefined;
    const alternative = (
      values.alternative?.alternative_value?.value || ''
    ).trim();

    if (!decision) {
      await ack({
        response_action: 'errors',
        errors: { decision: 'Please select a decision.' },
      });
      return;
    }
    if (decision === 'override' && !alternative) {
      await ack({
        response_action: 'errors',
        errors: { alternative: 'Please describe your alternative answer.' },
      });
      return;
    }

    const session = loadPiSession(metadata.sessionKey);
    if (!session || !session.tiebreakPiKey) {
      await ack({ response_action: 'clear' });
      return;
    }

    const pi = session.pis[0];
    const piKey = session.tiebreakPiKey;
    const answerText =
      decision === 'accept'
        ? pi.engRec
        : decision === 'override'
          ? alternative
          : 'flagged for discussion';

    insertAnswer({
      pr_number: session.prNumber,
      pi_key: piKey,
      answered_by: `tiebreak:${body.user.id}`,
      decision,
      answer_text: answerText,
      reasoning: decision === 'override' ? alternative : null,
      github_login: githubLoginForSlackUser(body.user.id) || null,
      answered_at: Date.now(),
    });

    resolveTiebreak(session.prNumber, piKey);

    await ack({
      response_action: 'update',
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Tie resolved' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ Recorded tie-break for PR #${session.prNumber} ${pi.id}.`,
            },
          },
        ],
      },
    });

    // Post the outcome in the tie-break thread.
    const channelId = session.channelId || SLACK_PI_CHANNEL;
    const threadTs = session.anchorTs;
    const outcomeDesc =
      decision === 'accept'
        ? 'accept eng rec'
        : decision === 'override'
          ? `override — _${alternative}_`
          : 'flag for discussion';
    try {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `✅ Tie resolved by <@${body.user.id}>: ${outcomeDesc}`,
      });
    } catch (err) {
      logger.error(
        { err, prNumber: session.prNumber },
        'Failed to post tie resolution',
      );
    }

    deletePiSession(metadata.sessionKey);
  });

  // --- Slash command fallback: /pi-answer <pr-number> ---
  app.command('/pi-answer', async ({ command, ack, client }) => {
    await ack();
    const prNumber = parseInt((command.text || '').trim(), 10);
    if (!prNumber) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'Usage: `/pi-answer <pr-number>` — Example: `/pi-answer 52`',
      });
      return;
    }

    // No anchor message yet — ensure a scan has run for this PR so we have
    // a notification message to thread onto, then open the modal.
    const notificationTs = await deps.ensureScan(prNumber, command.channel_id);
    const pis = await fetchPIsForPR(deps.github, prNumber);
    if (!pis || pis.length === 0) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `No Product Input questions found for PR #${prNumber}.`,
      });
      return;
    }

    const sessionKey = `session:${command.user_id}:${prNumber}`;
    let session = loadPiSession(sessionKey);
    if (!session) {
      session = {
        prNumber,
        userId: command.user_id,
        pis,
        currentIndex: 0,
        answers: {},
        startedAt: Date.now(),
        anchorTs: notificationTs || undefined,
        channelId: command.channel_id,
      };
    }
    savePiSession(sessionKey, session);

    // Ensure pi_pr_state reflects the thread_ts in case ensureScan created it.
    if (notificationTs) {
      upsertPiPrState(prNumber, { thread_ts: notificationTs });
    }

    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildPIModal({
          pi: session.pis[session.currentIndex],
          index: session.currentIndex,
          total: session.pis.length,
          prNumber,
          sessionKey,
        }),
      });
    } catch (err) {
      logger.error({ err, prNumber }, 'views.open failed for /pi-answer');
    }
  });
}
