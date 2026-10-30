import http from 'node:http';
import { webhookCallback } from 'grammy';

export function resolveWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let path = url.pathname;
  if (!path || path === '/') path = '/telegram';
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return { url: url.toString(), path };
}

export function createWebhookServer(bot, { port, path: webhookPath, secret }) {
  const handle = webhookPath
    ? webhookCallback(bot, 'http', {
        secretToken: secret || undefined,
        timeoutMilliseconds: 10_000,
        onTimeout: 'return',
      })
    : null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (!handle || url.pathname !== webhookPath) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }

    handle(req, res).catch((err) => {
      console.error('[webhook]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

/** Слушает PORT только ради health-check хостинга (режим long polling). */
export function createHealthServer(port) {
  return createWebhookServer(null, { port, path: null, secret: '' });
}

/** Проверяет, что публичный адрес ведёт именно к нам (ответ /health = ok). */
export async function isPublicUrlReachable(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(new URL('/health', baseUrl), { signal: controller.signal });
    const text = (await res.text()).trim();
    return res.ok && text === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function startWebhook(bot, { url, port, secret, allowedUpdates }) {
  const target = resolveWebhookUrl(url);
  if (!target) {
    throw new Error('WEBHOOK_URL должен быть полным адресом вида https://bot.example.com/telegram');
  }
  if (secret && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error('WEBHOOK_SECRET может содержать только буквы, цифры, _ и -, длина 1-256.');
  }

  const server = await createWebhookServer(bot, { port, path: target.path, secret });

  try {
    await bot.api.setWebhook(target.url, {
      secret_token: secret || undefined,
      allowed_updates: allowedUpdates,
    });
  } catch (err) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`Telegram не принял вебхук ${target.url}: ${err.message}`);
  }

  return { server, url: target.url, path: target.path };
}
