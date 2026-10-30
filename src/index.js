import { createBot } from './bot.js';
import { config } from './config.js';
import { ensureTree } from './treeService.js';
import { pollAlerts, pollFeed } from './poller.js';
import { startWebhook } from './webhook.js';

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
  log(`Вебхук: ${started.url} (порт ${config.port}, путь ${started.path})`);
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
    await startWebhookMode();
    log('Режим вебхука: жду обновления от Telegram.');
    return;
  }

  log('Режим long polling.');
  await bot.start({ allowed_updates: ALLOWED_UPDATES });

  clearInterval(timer);
  log('Бот остановлен.');
}

main().catch((err) => {
  console.error('Не удалось запустить бота:', err.message || err);
  process.exit(1);
});
