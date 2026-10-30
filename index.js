import { createBot } from './bot.js';
import { config } from './config.js';
import { ensureTree } from './treeService.js';
import { pollAlerts, pollFeed } from './poller.js';
import { createHealthServer, isPublicUrlReachable, startWebhook } from './webhook.js';

const TICK_MS = 15_000;
const ALLOWED_UPDATES = ['message', 'callback_query'];

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

if (!config.telegramToken) {
  console.error(
    [
      'Не задан BOT_TOKEN.',
      '',
      '1. Открой Telegram, напиши @BotFather команду /newbot.',
      '2. Придумай имя и username бота.',
      '3. Скопируй токен вида 123456789:AA... в файл .env:',
      '   BOT_TOKEN=твой_токен',
      '',
      'Файл .env.example лежит рядом, скопируй его в .env и заполни.',
    ].join('\n'),
  );
  process.exit(1);
}

const bot = createBot(config.telegramToken);

let stopped = false;
let timer = null;
let httpServer = null;

async function tick() {
  if (stopped) return;
  try {
    await pollFeed(bot.api);
  } catch (err) {
    log('Ошибка проверки новых тем:', err.message);
  }
  try {
    await pollAlerts(bot.api);
  } catch (err) {
    log('Ошибка проверки уведомлений:', err.message);
  }
}

async function startWebhookMode() {
  const started = await startWebhook(bot, {
    url: config.webhookUrl,
    port: config.port,
    secret: config.webhookSecret,
    allowedUpdates: ALLOWED_UPDATES,
  });
  httpServer = started.server;

  if (config.webhookUrlSource !== 'WEBHOOK_URL') {
    const reachable = await isPublicUrlReachable(started.url);
    if (!reachable) {
      await new Promise((resolve) => httpServer.close(resolve));
      httpServer = null;
      throw new Error(`адрес ${started.url} не отвечает (проверь домен приложения)`);
    }
  }

  log(`Вебхук: ${started.url} (порт ${config.port}, путь ${started.path}, адрес из ${config.webhookUrlSource === 'WEBHOOK_URL' ? 'WEBHOOK_URL' : 'окружения хостинга'})`);
}

async function logWebhookInfo() {
  try {
    const info = await bot.api.getWebhookInfo();
    const pending = `pending=${info.pending_update_count}`;
    if (!info.url) {
      log(`Вебхук в Telegram не установлен (${pending}).`);
      return;
    }
    const error = info.last_error_message ? `, ошибка: ${info.last_error_message}` : '';
    log(`Вебхук в Telegram: ${info.url} (${pending}${error})`);
  } catch (err) {
    log('Не удалось получить getWebhookInfo:', err.message);
  }
}

async function startPollingMode() {
  await bot.api.deleteWebhook().catch((err) => log('deleteWebhook не удался:', err.message));
  try {
    httpServer = await createHealthServer(config.port);
    log(`Health-сервер слушает порт ${config.port} (/ и /health → ok).`);
  } catch (err) {
    log(`Health-сервер не поднялся (${err.message}) — продолжаю без него.`);
  }
  log('Режим long polling: жду обновления от Telegram.');
  await logWebhookInfo();
  await bot.start({ allowed_updates: ALLOWED_UPDATES });
  clearInterval(timer);
  log('Бот остановлен.');
}

async function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  log(`Получен ${signal}, останавливаюсь…`);
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await bot.stop().catch(() => undefined);
  process.exit(0);
}

async function main() {
  await bot.init();
  log(`Бот @${bot.botInfo.username} запущен.`);

  ensureTree()
    .then((sections) => log(`Список разделов готов: секций ${sections.length}.`))
    .catch((err) => log('Не удалось загрузить разделы:', err.message));

  timer = setInterval(tick, TICK_MS);

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  if (config.webhookUrl) {
    try {
      await startWebhookMode();
      await logWebhookInfo();
      log('Режим вебхука: жду обновления от Telegram.');
      return;
    } catch (err) {
      log('Вебхук не поднялся:', err.message);
      log('Перехожу на long polling.');
    }
  } else {
    log('Вебхук-адрес не задан — работаю через long polling.');
  }

  await startPollingMode();
}

main().catch((err) => {
  console.error('Не удалось запустить бота:', err.message || err);
  process.exit(1);
});
