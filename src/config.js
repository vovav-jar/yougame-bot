import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* .env необязателен */
}

function envInt(name, def, min, max) {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function envPath(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
}

const mcpHome = envPath('YOUGAME_MCP_HOME', path.join(os.homedir(), '.yougame-mcp'));
const dataDir = envPath('BOT_DATA_DIR', path.join(root, 'data'));

export const config = {
  root,
  dataDir,
  statePath: path.join(dataDir, 'state.json'),
  treePath: path.join(dataDir, 'tree.json'),
  debugAlertsPath: path.join(dataDir, 'alerts-debug.html'),

  telegramToken: (process.env.BOT_TOKEN || '').trim(),
  ownerId: Number(process.env.OWNER_ID) || null,

  // Если WEBHOOK_URL задан — бот работает через вебхук, иначе через long polling.
  webhookUrl: (process.env.WEBHOOK_URL || '').trim().replace(/\/+$/, ''),
  webhookSecret: (process.env.WEBHOOK_SECRET || '').trim(),
  port: envInt('PORT', 8080, 1, 65_535),

  baseUrl: 'https://yougame.biz',
  userAgent:
    process.env.YOUGAME_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  // Общая с MCP сессия: вход через MCP или через бота — куки одни и те же.
  mcpHome,
  cookiesPath: envPath('YOUGAME_COOKIES_PATH', path.join(mcpHome, 'cookies.json')),
  browserProfileDir: envPath('YOUGAME_BROWSER_PROFILE', path.join(mcpHome, 'browser-profile')),

  feedIntervalSec: envInt('FEED_INTERVAL_SEC', 300, 60, 86_400),
  alertsIntervalSec: envInt('ALERTS_INTERVAL_SEC', 120, 60, 86_400),
  maxSelectedForums: envInt('MAX_SELECTED_FORUMS', 60, 1, 500),
  httpMinIntervalMs: envInt('HTTP_MIN_INTERVAL_MS', 1200, 0, 60_000),
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 30_000, 5_000, 120_000),
  loginTimeoutSec: envInt('LOGIN_TIMEOUT_SEC', 300, 30, 1800),
  maxSeenThreads: 5000,
  maxSeenAlerts: 2000,
};

export function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
