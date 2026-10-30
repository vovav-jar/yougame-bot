import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { getState, saveState } from './state.js';
import { subtreeIds } from './forums.js';
import {
  entryFor,
  ensureTree,
  initTreeFromCache,
  refreshTree,
  titleFor,
} from './treeService.js';
import {
  clearSession,
  fetchAlerts,
  hasSessionCookie,
  loginInteractive,
  rememberDebugHtml,
  AuthRequiredError,
  ChallengeError,
} from './yougame.js';
import { isAlertsBusy, isFeedBusy, pollAlerts, pollFeed } from './poller.js';
import {
  clip,
  esc,
  mainView,
  nodeView,
  sectionView,
  sectionsView,
  statusView,
} from './ui.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

function viewOptions(view) {
  return { ...HTML, reply_markup: view.keyboard };
}

async function render(ctx, view) {
  const options = viewOptions(view);
  try {
    await ctx.editMessageText(view.text, options);
  } catch (err) {
    const desc = err?.description || err?.message || '';
    if (/message is not modified/i.test(desc)) return;
    if (/message to edit not found/i.test(desc)) {
      await ctx.reply(view.text, options);
      return;
    }
    throw err;
  }
}

function nodeFor(id) {
  const entry = entryFor(id);
  if (entry) return entry.node;
  const state = getState();
  return {
    id: Number(id),
    title: state.forumTitles[id] || `Раздел ${id}`,
    children: [],
  };
}

function dropSelection(ids) {
  const state = getState();
  const selected = new Set(state.selectedForums);
  for (const id of ids) {
    selected.delete(id);
    state.seededForums = state.seededForums.filter((x) => Number(x) !== Number(id));
    delete state.forumMax[id];
  }
  state.selectedForums = [...selected];
  saveState();
}

function addSelection(ids) {
  const state = getState();
  const selected = new Set(state.selectedForums);
  for (const id of ids) {
    selected.add(id);
    state.forumTitles[id] = titleFor(id);
  }
  state.selectedForums = [...selected];
  saveState();
}

function toggleNode(id) {
  const node = nodeFor(id);
  const ids = subtreeIds(node);
  const state = getState();
  const selected = new Set(state.selectedForums);
  const all = ids.every((x) => selected.has(x));

  if (all) {
    dropSelection(ids);
    return { removed: ids.length, added: 0 };
  }

  const toAdd = ids.filter((x) => !selected.has(x));
  if (selected.size + toAdd.length > config.maxSelectedForums) {
    return {
      error: `Лимит ${config.maxSelectedForums} разделов. Сними лишние или выбирай разделы точнее.`,
    };
  }
  addSelection(toAdd);
  return { added: toAdd.length, removed: 0 };
}

function selectWholeNode(id) {
  const node = nodeFor(id);
  const ids = subtreeIds(node);
  const state = getState();
  const selected = new Set(state.selectedForums);
  const toAdd = ids.filter((x) => !selected.has(x));
  if (!toAdd.length) return { added: 0, removed: 0 };
  if (selected.size + toAdd.length > config.maxSelectedForums) {
    return {
      error: `Лимит ${config.maxSelectedForums} разделов. Выбирай разделы точнее.`,
    };
  }
  addSelection(toAdd);
  return { added: toAdd.length, removed: 0 };
}

function clearWholeNode(id) {
  const node = nodeFor(id);
  const ids = subtreeIds(node);
  const state = getState();
  const selected = new Set(state.selectedForums);
  const present = ids.filter((x) => selected.has(x));
  if (!present.length) return { added: 0, removed: 0 };
  dropSelection(present);
  return { added: 0, removed: present.length };
}

function toggleAnswer(result) {
  if (result.error) return { text: result.error, show_alert: true };
  if (result.added) return { text: `Добавлено: ${result.added}` };
  if (result.removed) return { text: `Снято: ${result.removed}` };
  return { text: 'Без изменений' };
}

async function sendView(ctx, view) {
  await ctx.reply(view.text, viewOptions(view));
}

async function runCheck(bot, chatId, messageId = null) {
  if (isFeedBusy() || isAlertsBusy()) {
    const text = 'Проверка уже идёт, подожди.';
    if (messageId) await bot.api.editMessageText(chatId, messageId, text).catch(() => undefined);
    else await bot.api.sendMessage(chatId, text).catch(() => undefined);
    return;
  }

  const feed = await pollFeed(bot.api, { force: true });
  const alerts = await pollAlerts(bot.api, { force: true });
  const state = getState();

  const lines = [];
  if (feed.status === 'disabled') {
    lines.push('Новые темы: отслеживание выключено.');
  } else if (feed.status === 'busy') {
    lines.push('Новые темы: проверка уже идёт.');
  } else if (!state.selectedForums.length) {
    lines.push('Новые темы: разделы не выбраны.');
  } else {
    lines.push(
      `Новые темы: проверено разделов ${feed.forums}, отправлено ${feed.sent}` +
        (feed.errors ? `, ошибок ${feed.errors}` : '') +
        '.',
    );
    if (feed.error) lines.push(`Ошибка: ${esc(clip(feed.error, 200))}`);
  }

  switch (alerts.status) {
    case 'disabled':
      lines.push('Уведомления: отслеживание выключено.');
      break;
    case 'busy':
      lines.push('Уведомления: проверка уже идёт.');
      break;
    case 'no-session':
      lines.push('Уведомления: нет сохранённой сессии, выполни /login.');
      break;
    case 'auth':
      lines.push('Уведомления: сессия истекла, выполни /login.');
      break;
    case 'seeded':
      lines.push(`Уведомления: подключены, на странице ${alerts.found || 0}.`);
      break;
    case 'done':
      lines.push(`Уведомления: новых ${alerts.sent} (всего на странице ${alerts.found || 0}).`);
      break;
    default:
      lines.push(`Уведомления: ошибка — ${esc(clip(alerts.error || alerts.status, 200))}`);
  }

  const text = `Проверка завершена.\n\n${lines.join('\n')}`;
  if (messageId) {
    await bot.api.editMessageText(chatId, messageId, text, HTML).catch(() => undefined);
  } else {
    await bot.api.sendMessage(chatId, text, HTML).catch(() => undefined);
  }
}

async function startLogin(bot, chatId) {
  try {
    const result = await loginInteractive();
    const state = getState();
    if (result.ok) {
      state.sessionUsername = result.username;
      state.sessionOk = true;
      state.sessionCheckedAt = Date.now();
      state.authNoticeAt = 0;
      state.lastAlertsError = null;
      saveState();
      await bot.api.sendMessage(
        chatId,
        `Вход выполнен${result.username ? ` как ${result.username}` : ''}. Сессия сохранена и общая с MCP.`,
      );
      pollAlerts(bot.api, { force: true }).catch(() => undefined);
    } else {
      await bot.api.sendMessage(
        chatId,
        `Вход не завершён: ${result.reason || 'окно закрыто'}. Попробуй /login ещё раз.`,
      );
    }
  } catch (err) {
    await bot.api
      .sendMessage(chatId, `Ошибка входа: ${clip(err.message, 300)}`)
      .catch(() => undefined);
  }
}

async function showLatestAlerts(bot, chatId) {
  if (!hasSessionCookie()) {
    await bot.api.sendMessage(chatId, 'Нет сессии. Выполни /login.');
    return;
  }
  try {
    const { alerts, username } = await fetchAlerts();
    const state = getState();
    state.sessionOk = true;
    state.sessionUsername = username || state.sessionUsername;
    state.sessionCheckedAt = Date.now();
    saveState();

    if (!alerts.length) {
      await bot.api.sendMessage(chatId, 'На странице уведомлений пусто.');
      return;
    }

    const lines = ['<b>Последние уведомления</b>'];
    alerts.slice(0, 8).forEach((alert, i) => {
      const title = esc(clip(alert.title, 300));
      const link = alert.url ? `<a href="${esc(alert.url)}">${title}</a>` : title;
      lines.push(`${i + 1}. ${link}`);
      if (alert.meta) lines.push(`   ${esc(clip(alert.meta, 100))}`);
    });
    if (alerts.length > 8) lines.push(`\nПоказаны 8 из ${alerts.length}.`);
    await bot.api.sendMessage(chatId, lines.join('\n'), HTML);
  } catch (err) {
    const message =
      err instanceof AuthRequiredError
        ? 'Сессия недействительна. Выполни /login.'
        : `Не удалось получить уведомления: ${clip(err.message, 300)}`;
    await bot.api.sendMessage(chatId, message).catch(() => undefined);
  }
}

async function dumpAlerts(bot, chatId) {
  if (!hasSessionCookie()) {
    await bot.api.sendMessage(chatId, 'Нет сессии. Выполни /login.');
    return;
  }
  try {
    const { alerts, html } = await fetchAlerts();
    const file = rememberDebugHtml(html);
    await bot.api.sendMessage(
      chatId,
      `Сохранил страницу уведомлений (распознано: ${alerts.length}) в:\n<code>${esc(file)}</code>`,
      HTML,
    );
  } catch (err) {
    await bot.api.sendMessage(chatId, `Не удалось сохранить: ${clip(err.message, 300)}`);
  }
}

function helpText() {
  return [
    '<b>Команды</b>',
    '/start — главное меню',
    '/check — проверить новые темы и уведомления сейчас',
    '/status — состояние бота и сессии',
    '/login — открыть браузер и войти на yougame.biz',
    '/logout — удалить сохранённую сессию',
    '/refresh — обновить список разделов',
    '/alerts — показать последние уведомления',
    '/dump_alerts — сохранить страницу уведомлений для разбора',
    '/id — ваш Telegram ID',
    '',
    'Выбор разделов — кнопка «Разделы» в главном меню.',
  ].join('\n');
}

export function createBot(token) {
  const bot = new Bot(token);
  const state = getState();

  if (config.ownerId) {
    state.ownerId = config.ownerId;
    saveState();
  }

  bot.use(async (ctx, next) => {
    const s = getState();

    if (!s.ownerId) {
      if (ctx.chat?.type === 'private' && ctx.from) {
        s.ownerId = ctx.from.id;
        s.chatId = ctx.chat.id;
        saveState();
      } else {
        return;
      }
    }

    if (ctx.chat?.type !== 'private') return;

    if (ctx.from?.id !== s.ownerId) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: 'Бот личный', show_alert: true }).catch(() => undefined);
      } else {
        await ctx.reply('Этот бот настроен для одного владельца.').catch(() => undefined);
      }
      return;
    }

    if (s.chatId !== ctx.chat.id) {
      s.chatId = ctx.chat.id;
      saveState();
    }

    await next();
  });

  bot.command('start', async (ctx) => {
    ensureTree().catch(() => undefined);
    await sendView(ctx, mainView());
  });

  bot.command('menu', async (ctx) => {
    await sendView(ctx, mainView());
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(helpText(), HTML);
  });

  bot.command('status', async (ctx) => {
    await sendView(ctx, statusView());
  });

  bot.command('id', async (ctx) => {
    await ctx.reply(`user_id: ${ctx.from.id}\nchat_id: ${ctx.chat.id}`);
  });

  bot.command('check', async (ctx) => {
    const msg = await ctx.reply('Проверяю разделы и уведомления…');
    runCheck(bot, ctx.chat.id, msg.message_id).catch(console.error);
  });

  bot.command('login', async (ctx) => {
    await ctx.reply(
      'Открываю окно Chromium. Войди на yougame.biz вручную (пароль, капча, 2FA). После входа окно закроется само.',
    );
    startLogin(bot, ctx.chat.id);
  });

  bot.command('logout', async (ctx) => {
    clearSession();
    const s = getState();
    s.sessionUsername = null;
    s.sessionOk = false;
    s.sessionCheckedAt = Date.now();
    s.alertsSeeded = false;
    s.seenAlerts = [];
    s.emptyAlertsStreak = 0;
    saveState();
    await ctx.reply('Сессия удалена. Куки общие с MCP, поэтому MCP тоже попросит вход.');
  });

  bot.command('refresh', async (ctx) => {
    await ctx.reply('Обновляю список разделов…');
    try {
      const sections = await refreshTree();
      const total = sections.reduce((acc, section) => {
        const walk = (node) => 1 + node.children.reduce((n, child) => n + walk(child), 0);
        return acc + section.forums.reduce((n, forum) => n + walk(forum), 0);
      }, 0);
      await sendView(ctx, sectionsView(0));
      await ctx.reply(`Готово: секций ${sections.length}, разделов ${total}.`);
    } catch (err) {
      await ctx.reply(`Не удалось обновить разделы: ${clip(err.message, 300)}`);
    }
  });

  bot.command('alerts', async (ctx) => {
    await showLatestAlerts(bot, ctx.chat.id);
  });

  bot.command('dump_alerts', async (ctx) => {
    await dumpAlerts(bot, ctx.chat.id);
  });

  bot.on('message:text', async (ctx) => {
    await ctx.reply('Не понял команду. /help — список команд.');
  });

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery('menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    await render(ctx, mainView());
  });

  bot.callbackQuery('ta', async (ctx) => {
    const s = getState();
    s.alertsEnabled = !s.alertsEnabled;
    saveState();
    await ctx.answerCallbackQuery({ text: s.alertsEnabled ? 'Уведомления включены' : 'Уведомления выключены' });
    await render(ctx, mainView());
  });

  bot.callbackQuery('tt', async (ctx) => {
    const s = getState();
    s.threadsEnabled = !s.threadsEnabled;
    saveState();
    await ctx.answerCallbackQuery({
      text: s.threadsEnabled ? 'Новые темы включены' : 'Новые темы выключены',
    });
    await render(ctx, mainView());
  });

  bot.callbackQuery(/^sections\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await render(ctx, sectionsView(Number(ctx.match[1])));
  });

  bot.callbackQuery(/^sv\|(\d+)\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await render(ctx, sectionView(Number(ctx.match[1]), Number(ctx.match[2])));
  });

  bot.callbackQuery(/^nv\|(\d+)\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await render(ctx, nodeView(Number(ctx.match[1]), Number(ctx.match[2])));
  });

  bot.callbackQuery(/^tg\|(\d+)\|s\|(\d+)\|(\d+)$/, async (ctx) => {
    const result = toggleNode(Number(ctx.match[1]));
    await ctx.answerCallbackQuery(toggleAnswer(result));
    await render(ctx, sectionView(Number(ctx.match[2]), Number(ctx.match[3])));
  });

  bot.callbackQuery(/^tg\|(\d+)\|n\|(\d+)\|(\d+)$/, async (ctx) => {
    const result = toggleNode(Number(ctx.match[1]));
    await ctx.answerCallbackQuery(toggleAnswer(result));
    await render(ctx, nodeView(Number(ctx.match[2]), Number(ctx.match[3])));
  });

  bot.callbackQuery(/^sa\|(\d+)\|(\d+)$/, async (ctx) => {
    const result = selectWholeNode(Number(ctx.match[1]));
    await ctx.answerCallbackQuery(toggleAnswer(result));
    await render(ctx, nodeView(Number(ctx.match[1]), Number(ctx.match[2])));
  });

  bot.callbackQuery(/^sn\|(\d+)\|(\d+)$/, async (ctx) => {
    const result = clearWholeNode(Number(ctx.match[1]));
    await ctx.answerCallbackQuery(toggleAnswer(result));
    await render(ctx, nodeView(Number(ctx.match[1]), Number(ctx.match[2])));
  });

  bot.callbackQuery('check', async (ctx) => {
    if (isFeedBusy() || isAlertsBusy()) {
      await ctx.answerCallbackQuery({ text: 'Проверка уже идёт', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Проверяю' });
    const msg = await ctx.reply('Проверяю разделы и уведомления…');
    runCheck(bot, ctx.chat.id, msg.message_id).catch(console.error);
  });

  bot.callbackQuery('status', async (ctx) => {
    await ctx.answerCallbackQuery();
    await render(ctx, statusView());
  });

  bot.callbackQuery('login', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Открываю браузер' });
    await ctx.reply(
      'Открываю окно Chromium. Войди на yougame.biz вручную. После входа окно закроется само.',
    );
    startLogin(bot, ctx.chat.id);
  });

  bot.callbackQuery('refresh', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Обновляю' });
    try {
      await refreshTree();
      await render(ctx, sectionsView(0));
    } catch (err) {
      await ctx.reply(`Не удалось обновить разделы: ${clip(err.message, 300)}`).catch(() => undefined);
    }
  });

  bot.callbackQuery('sess', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Проверяю сессию…' });
    try {
      const { username } = await fetchAlerts();
      const s = getState();
      s.sessionOk = true;
      s.sessionUsername = username || s.sessionUsername;
      s.sessionCheckedAt = Date.now();
      s.lastAlertsError = null;
      saveState();
    } catch (err) {
      const s = getState();
      s.sessionCheckedAt = Date.now();
      if (err instanceof AuthRequiredError) {
        s.sessionOk = false;
        s.lastAlertsError = err.message;
      } else {
        s.lastAlertsError = err.message;
      }
      saveState();
    }
    await render(ctx, statusView());
  });

  bot.catch(async (err) => {
    console.error('[bot]', err.error);
    const s = getState();
    const chatId = s.chatId || s.ownerId;
    if (!chatId) return;
    const message = err.error instanceof ChallengeError ? err.error.message : err.error?.message || String(err.error);
    await bot.api
      .sendMessage(chatId, `Ошибка бота: ${clip(message, 300)}`)
      .catch(() => undefined);
  });

  initTreeFromCache();

  bot.api
    .setMyCommands([
      { command: 'start', description: 'Главное меню' },
      { command: 'check', description: 'Проверить сейчас' },
      { command: 'status', description: 'Состояние и сессия' },
      { command: 'login', description: 'Войти на yougame.biz' },
      { command: 'logout', description: 'Удалить сессию' },
      { command: 'refresh', description: 'Обновить разделы' },
      { command: 'alerts', description: 'Последние уведомления' },
      { command: 'help', description: 'Список команд' },
    ])
    .catch(() => undefined);

  return bot;
}
