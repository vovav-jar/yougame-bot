import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { getState, saveState, markSeen, isSeen } from './state.js';
import { getIndex, titleFor } from './treeService.js';
import {
  AuthRequiredError,
  fetchAlerts,
  fetchForumThreads,
  hasSessionCookie,
} from './yougame.js';
import { clip, esc } from './ui.js';

let feedBusy = false;
let alertsBusy = false;

export const isFeedBusy = () => feedBusy;
export const isAlertsBusy = () => alertsBusy;

function chatTarget() {
  const state = getState();
  return state.chatId || state.ownerId;
}

function trimSeenThreads(state) {
  if (state.seenThreads.length > config.maxSeenThreads) {
    state.seenThreads.splice(0, state.seenThreads.length - config.maxSeenThreads);
  }
}

function threadMessage(thread, forumTitle) {
  const lines = [
    '<b>Новая тема</b>',
    `Раздел: ${esc(clip(forumTitle, 100))}`,
    `<b>${esc(clip(thread.title, 350))}</b>`,
  ];
  const meta = [];
  if (thread.author) meta.push(`Автор: ${esc(thread.author)}`);
  if (thread.startDate) meta.push(`Создана: ${esc(thread.startDate)}`);
  if (meta.length) lines.push(meta.join(' · '));
  return lines.join('\n');
}

async function sendThread(api, chatId, thread, forumTitle) {
  const kb = new InlineKeyboard().url('Открыть тему', thread.url);
  await api.sendMessage(chatId, threadMessage(thread, forumTitle), {
    parse_mode: 'HTML',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

function alertMessage(alert) {
  const lines = ['<b>Уведомление YouGame</b>', esc(clip(alert.title, 600))];
  if (alert.meta) lines.push(`Время: ${esc(clip(alert.meta, 120))}`);
  return lines.join('\n');
}

async function sendAlert(api, chatId, alert) {
  const options = {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (alert.url) options.reply_markup = new InlineKeyboard().url('Открыть', alert.url);
  await api.sendMessage(chatId, alertMessage(alert), options);
}

async function notifyFeedFailure(api, message) {
  const state = getState();
  const now = Date.now();
  if (state.feedNoticeAt && now - state.feedNoticeAt < 12 * 60 * 60 * 1000) return;
  state.feedNoticeAt = now;
  saveState();
  const chatId = chatTarget();
  if (!chatId) return;
  await api
    .sendMessage(chatId, `Не удалось прочитать разделы форума.\n${clip(message, 300)}`)
    .catch(() => undefined);
}

export async function pollFeed(api, { force = false } = {}) {
  const state = getState();
  if (!state.threadsEnabled) return { status: 'disabled', sent: 0 };
  if (!force && Date.now() - state.lastFeedAt < config.feedIntervalSec * 1000) {
    return { status: 'not-due', sent: 0 };
  }
  if (feedBusy) return { status: 'busy', sent: 0 };
  feedBusy = true;

  const summary = { status: 'done', forums: 0, sent: 0, errors: 0, error: null };

  try {
    state.lastFeedAt = Date.now();
    saveState();

    const ids = [...new Set(state.selectedForums.map(Number))];
    if (!ids.length) {
      state.lastFeedError = null;
      saveState();
      return summary;
    }

    const chatId = chatTarget();
    const index = getIndex();

    for (const id of ids) {
      const entry = index?.get(id);
      const node = entry?.node || { id, title: titleFor(id), children: [] };
      try {
        const threads = await fetchForumThreads(id);
        summary.forums += 1;

        const seeded = state.seededForums.includes(id);
        const maxSeen = Number(state.forumMax[id] || 0);
        const pageMax = threads.reduce((max, t) => Math.max(max, t.id), 0);

        if (!seeded) {
          if (!threads.length) continue;
          state.seededForums.push(id);
          state.forumMax[id] = pageMax;
          for (const thread of threads) {
            if (!state.seenThreads.includes(thread.id)) state.seenThreads.push(thread.id);
          }
          trimSeenThreads(state);
          saveState();
          continue;
        }

        const fresh = threads
          .filter((t) => t.id > maxSeen && !state.seenThreads.includes(t.id))
          .sort((a, b) => a.id - b.id);

        let lastOk = maxSeen;
        let failed = false;

        for (const thread of fresh) {
          if (!chatId) {
            failed = true;
            summary.error = 'Не задан чат для отправки';
            break;
          }
          try {
            await sendThread(api, chatId, thread, node.title);
            markSeen('threads', thread.id, config.maxSeenThreads);
            lastOk = Math.max(lastOk, thread.id);
            summary.sent += 1;
            saveState();
          } catch (err) {
            failed = true;
            summary.error = err.message;
            break;
          }
        }

        state.forumMax[id] = failed ? lastOk : Math.max(lastOk, pageMax);

        if (!failed) {
          // ничего не сломалось — ошибка этого раздела больше не актуальна
          if (state.lastFeedError?.startsWith(node.title + ':')) state.lastFeedError = null;
        }
        saveState();
      } catch (err) {
        summary.errors += 1;
        summary.error = err.message;
        state.lastFeedError = `${node.title}: ${err.message}`;
        saveState();
      }
    }

    if (!summary.errors && !summary.error) state.lastFeedError = null;
    saveState();

    if (summary.forums === 0 && summary.errors > 0 && summary.error) {
      await notifyFeedFailure(api, summary.error);
    }

    return summary;
  } finally {
    feedBusy = false;
  }
}

export async function pollAlerts(api, { force = false } = {}) {
  const state = getState();
  if (!state.alertsEnabled) return { status: 'disabled', sent: 0 };
  if (!force && Date.now() - state.lastAlertsAt < config.alertsIntervalSec * 1000) {
    return { status: 'not-due', sent: 0 };
  }
  if (alertsBusy) return { status: 'busy', sent: 0 };
  alertsBusy = true;

  try {
    state.lastAlertsAt = Date.now();
    saveState();

    if (!hasSessionCookie()) {
      if (state.sessionUsername) state.sessionOk = false;
      saveState();
      return { status: 'no-session', sent: 0 };
    }

    const result = await fetchAlerts();
    const now = Date.now();
    state.sessionOk = true;
    state.sessionUsername = result.username || state.sessionUsername;
    state.sessionCheckedAt = now;
    state.authNoticeAt = 0;
    state.lastAlertsError = null;
    saveState();

    const chatId = chatTarget();

    if (!state.alertsSeeded) {
      for (const alert of result.alerts) markSeen('alerts', alert.key, config.maxSeenAlerts);
      state.alertsSeeded = true;
      saveState();
      if (chatId) {
        await api
          .sendMessage(
            chatId,
            result.alerts.length
              ? `Уведомления подключены. На странице уже есть ${result.alerts.length} — отметил их прочитанными, дальше буду присылать новые.`
              : 'Уведомления подключены. Новых пока нет.',
          )
          .catch(() => undefined);
      }
      return { status: 'seeded', sent: 0, found: result.alerts.length };
    }

    const fresh = result.alerts.filter((alert) => !isSeen('alerts', alert.key)).reverse();
    let sent = 0;

    for (const alert of fresh) {
      if (!chatId) return { status: 'no-chat', sent, error: 'Не задан чат для отправки' };
      try {
        await sendAlert(api, chatId, alert);
        markSeen('alerts', alert.key, config.maxSeenAlerts);
        sent += 1;
        saveState();
      } catch (err) {
        return { status: 'send-error', sent, error: err.message };
      }
    }

    state.emptyAlertsStreak = result.alerts.length ? 0 : state.emptyAlertsStreak + 1;
    if (
      state.emptyAlertsStreak >= 3 &&
      chatId &&
      (!state.emptyWarnedAt || now - state.emptyWarnedAt > 7 * 24 * 60 * 60 * 1000)
    ) {
      state.emptyWarnedAt = now;
      saveState();
      await api
        .sendMessage(
          chatId,
          'Три проверки подряд не вижу ни одного уведомления на странице. Возможно, изменилась вёрстка форума. Пришли /dump_alerts, чтобы сохранить страницу для разбора.',
        )
        .catch(() => undefined);
    }

    saveState();
    return { status: 'done', sent, found: result.alerts.length };
  } catch (err) {
    const now = Date.now();
    state.lastAlertsError = err.message;
    saveState();

    if (err instanceof AuthRequiredError) {
      state.sessionOk = false;
      state.sessionCheckedAt = now;
      saveState();
      const chatId = chatTarget();
      if (chatId && (!state.authNoticeAt || now - state.authNoticeAt > 12 * 60 * 60 * 1000)) {
        state.authNoticeAt = now;
        saveState();
        await api
          .sendMessage(chatId, 'Сессия YouGame истекла. Выполни /login, чтобы снова получать уведомления.')
          .catch(() => undefined);
      }
      return { status: 'auth', sent: 0, error: err.message };
    }

    return { status: 'error', sent: 0, error: err.message };
  } finally {
    alertsBusy = false;
  }
}
