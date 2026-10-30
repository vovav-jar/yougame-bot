import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { config, ensureDirs } from './config.js';
import { writeFileAtomic } from './atomic.js';
import { parseForumTree } from './forums.js';

export class AuthRequiredError extends Error {
  constructor(message = 'Нужен вход на форум') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class ChallengeError extends Error {
  constructor(message = 'Форум не пропустил антибот-проверку') {
    super(message);
    this.name = 'ChallengeError';
  }
}

export class HttpError extends Error {
  constructor(status, url, message) {
    super(message || `HTTP ${status}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let jar = null;
let jarMtime = 0;

function jarFileMtime() {
  try {
    return fs.statSync(config.cookiesPath).mtimeMs;
  } catch {
    return 0;
  }
}

function readJarFromDisk() {
  try {
    const raw = fs.readFileSync(config.cookiesPath, 'utf8');
    jar = CookieJar.deserializeSync(JSON.parse(raw));
    jarMtime = jarFileMtime();
  } catch {
    jar = new CookieJar();
    jarMtime = 0;
  }
}

export function getJar() {
  if (!jar) readJarFromDisk();
  return jar;
}

/** Подхватывает куки, которые обновил MCP (например, после yg_login). */
function reloadJarIfChanged() {
  const mtime = jarFileMtime();
  if (mtime && mtime !== jarMtime) readJarFromDisk();
}

export function saveJar() {
  ensureDirs();
  fs.mkdirSync(path.dirname(config.cookiesPath), { recursive: true });
  writeFileAtomic(config.cookiesPath, JSON.stringify(getJar().serializeSync(), null, 2), { mode: 0o600 });
  jarMtime = jarFileMtime();
}

export function hasSessionCookie() {
  try {
    reloadJarIfChanged();
    const all = getJar().getCookiesSync(config.baseUrl);
    return all.some((c) => (c.key === 'xf_user' || c.key === 'xf_session') && c.value);
  } catch {
    return false;
  }
}

export function clearSession() {
  jar = new CookieJar();
  ensureDirs();
  try {
    fs.rmSync(config.cookiesPath, { force: true });
  } catch {
    /* файла может не быть */
  }
  jarMtime = 0;
}

export function importBrowserCookies(cookies) {
  const target = new URL(config.baseUrl);
  let count = 0;
  for (const c of cookies) {
    const domain = (c.domain || '').replace(/^\./, '');
    if (!domain || !(domain === target.hostname || target.hostname.endsWith('.' + domain))) continue;
    const parts = [`${c.name}=${c.value}`, `Domain=${domain}`, `Path=${c.path || '/'}`];
    if (c.expires && c.expires > 0) parts.push(`Expires=${new Date(c.expires * 1000).toUTCString()}`);
    if (c.secure) parts.push('Secure');
    if (c.httpOnly) parts.push('HttpOnly');
    try {
      getJar().setCookieSync(parts.join('; '), config.baseUrl, { ignoreError: true });
      count += 1;
    } catch {
      /* битую куку пропускаем */
    }
  }
  if (count) saveJar();
  return count;
}

// ---------------------------------------------------------------------------
// HTTP с троттлингом, редиректами и обновлением антибот-кук
// ---------------------------------------------------------------------------

let chain = Promise.resolve();
let lastRequestAt = 0;

function schedule(fn) {
  const run = chain.then(async () => {
    const wait = config.httpMinIntervalMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

function setCookiesOf(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

async function requestOnce(target, headers) {
  const res = await schedule(() =>
    fetch(target, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }),
  );
  for (const value of setCookiesOf(res)) {
    try {
      getJar().setCookieSync(value, target, { ignoreError: true });
      saveJar();
    } catch {
      /* пропускаем */
    }
  }
  return res;
}

async function fetchFollow(target) {
  let current = target;
  let lastError = null;
  let failures = 0;

  for (let hop = 0; hop < 8; hop++) {
    reloadJarIfChanged();
    const cookie = (() => {
      try {
        return getJar().getCookieStringSync(current);
      } catch {
        return '';
      }
    })();
    const headers = {
      'User-Agent': config.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
    };
    if (cookie) headers.Cookie = cookie;

    let res;
    try {
      res = await requestOnce(current, headers);
    } catch (err) {
      lastError = err;
      if (failures++ < 2) {
        await sleep(700 * failures);
        hop -= 1;
        continue;
      }
      throw new HttpError(0, current, `Сеть недоступна: ${err.message}`);
    }

    if (res.status >= 500 && failures++ < 2) {
      await sleep(900 * failures);
      hop -= 1;
      continue;
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }

    const body = await res.text();
    return { status: res.status, finalUrl: current, body };
  }

  throw new HttpError(0, target, lastError ? lastError.message : 'Слишком много редиректов');
}

function looksLikeChallenge(body, status) {
  if (status === 429) return true;
  return /Проверка браузера/.test(body) || (body.includes('class="ab"') && body.includes('keyframes absp'));
}

function isLoginUrl(finalUrl) {
  try {
    return /^\/login(\/|$)/.test(new URL(finalUrl).pathname);
  } catch {
    return false;
  }
}

let warmupPromise = null;

/** Открывает headless-браузер, проходит JS-проверку и переносит куки в jar. */
export async function warmup() {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new ChallengeError(
        'Нужен Chromium для Playwright. Выполни в папке bot: npx playwright install chromium',
      );
    }

    fs.mkdirSync(config.browserProfileDir, { recursive: true });
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(config.browserProfileDir, {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
        userAgent: config.userAgent,
        locale: 'ru-RU',
        viewport: { width: 1280, height: 900 },
      });
    } catch (err) {
      throw new ChallengeError(
        `Не удалось запустить Chromium: ${err.message}. Если окно MCP-логина открыто — закрой его и повтори.`,
      );
    }

    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page
        .goto(config.baseUrl + '/forums/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch(() => undefined);

      let passed = false;
      for (let i = 0; i < 45; i++) {
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (!/Проверка браузера/.test(text)) {
          passed = true;
          break;
        }
        await page.waitForTimeout(1000);
      }

      await page.waitForTimeout(1000);
      const cookies = await ctx.cookies();
      importBrowserCookies(cookies);
      if (!passed) throw new ChallengeError('Антибот-проверка не завершилась за 45 секунд.');
    } finally {
      await ctx.close().catch(() => undefined);
    }
  })();

  try {
    return await warmupPromise;
  } finally {
    warmupPromise = null;
  }
}

export async function fetchPage(pathname) {
  const target = /^https?:\/\//i.test(pathname) ? pathname : config.baseUrl + pathname;
  let page = await fetchFollow(target);

  if (looksLikeChallenge(page.body, page.status)) {
    await warmup();
    page = await fetchFollow(target);
  }

  if (looksLikeChallenge(page.body, page.status)) {
    throw new ChallengeError(
      'Форум снова отдал проверку браузера. Выполни /login — окно браузера обновит куки.',
    );
  }

  return {
    ...page,
    html: page.body,
    loggedIn: /data-logged-in="true"/.test(page.body),
    loginPage: isLoginUrl(page.finalUrl) || /data-template="login"/.test(page.body),
    username:
      clean(cheerio.load(page.body)('.p-navgroup-link--user .p-navgroup-linkText').first().text()) ||
      null,
    csrf: (page.body.match(/data-csrf="([^"]+)"/) || [])[1] || null,
  };
}

// ---------------------------------------------------------------------------
// Вход через реальное окно браузера
// ---------------------------------------------------------------------------

let loginPromise = null;

export async function loginInteractive() {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error('Playwright не установлен. Выполни: npm install && npx playwright install chromium');
    }

    fs.mkdirSync(config.browserProfileDir, { recursive: true });
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(config.browserProfileDir, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        userAgent: config.userAgent,
        locale: 'ru-RU',
        viewport: { width: 1280, height: 900 },
      });
    } catch (err) {
      throw new Error(
        `Не удалось открыть браузер: ${err.message}. Закрой окно браузера MCP, если оно открыто.`,
      );
    }

    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(config.baseUrl + '/login/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

      const deadline = Date.now() + config.loginTimeoutSec * 1000;
      let username = null;
      while (Date.now() < deadline) {
        const cookies = await ctx.cookies(config.baseUrl);
        if (cookies.some((c) => c.name === 'xf_user' && c.value)) {
          await page.waitForTimeout(1500);
          const fresh = await ctx.cookies();
          importBrowserCookies(fresh);
          username = clean(
            await page
              .locator('.p-navgroup-link--user .p-navgroup-linkText')
              .first()
              .textContent({ timeout: 2000 })
              .catch(() => ''),
          );
          return { ok: true, username: username || null };
        }
        await page.waitForTimeout(1500);
      }
      return { ok: false, username: null, reason: `вход не завершён за ${config.loginTimeoutSec} с` };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  })();

  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Парсеры
// ---------------------------------------------------------------------------

function threadIdFromHref(href) {
  const m = /\/threads\/(?:[^/?#]*\.)?(\d+)(?:\/|$|[?#])/.exec(href || '');
  return m ? Number(m[1]) : null;
}

export function parseForumThreads(html) {
  const $ = cheerio.load(html);
  const threads = [];
  const seen = new Set();

  $('.structItem--thread').each((_, el) => {
    const root = $(el);
    const link = root.find('.structItem-title a[href*="/threads/"]').first();
    const href = link.attr('href') || '';
    const id = threadIdFromHref(href);
    if (!id || seen.has(id)) return;
    seen.add(id);

    threads.push({
      id,
      title: clean(link.text()),
      author: clean(root.find('.structItem-parts a.username').first().text()) || null,
      startDate: clean(root.find('.structItem-startDate').first().text()) || null,
      sticky: root.find('.structItem-status--sticky').length > 0,
      url: `${config.baseUrl}/threads/${id}/`,
    });
  });

  return threads;
}

export async function fetchForumThreads(forumId) {
  const page = await fetchPage(`/forums/${forumId}/`);
  if (page.status >= 400) throw new HttpError(page.status, page.finalUrl);
  return parseForumThreads(page.html);
}

export async function fetchTree() {
  const page = await fetchPage('/forums/');
  if (page.status >= 400) throw new HttpError(page.status, page.finalUrl, `HTTP ${page.status} на /forums/`);
  const sections = parseForumTree(page.html);
  if (!sections.length) throw new Error('Не удалось разобрать список разделов — вероятно, изменилась вёрстка.');
  return sections;
}

function alertKey({ url, title, datetime }) {
  return crypto
    .createHash('sha1')
    .update(`${url}|${title}|${datetime || ''}`)
    .digest('hex')
    .slice(0, 20);
}

export function parseAlerts(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('li.alert').each((_, el) => {
    const root = $(el);
    const titleEl = root.find('.alert-title').first();
    const title =
      clean(titleEl.text()) ||
      clean(root.find('.alert-content').text()).slice(0, 300) ||
      clean(root.text()).slice(0, 300);
    if (!title) return;

    const anchors = root.find('a[href]').toArray();
    const bad = (h) =>
      !h ||
      h.startsWith('#') ||
      h.startsWith('javascript:') ||
      /\/members\//.test(h) ||
      /\/account\//.test(h) ||
      /\/misc\//.test(h);

    let href = '';
    for (const a of anchors) {
      const h = $(a).attr('href') || '';
      if (bad(h)) continue;
      if (/\/(posts|threads|profile-posts|resources|media|gallery)\//.test(h)) {
        href = h;
        break;
      }
    }
    if (!href) {
      for (const a of anchors) {
        const h = $(a).attr('href') || '';
        if (!bad(h)) {
          href = h;
          break;
        }
      }
    }

    let url = '';
    if (href) {
      try {
        url = new URL(href, config.baseUrl).toString();
      } catch {
        url = href;
      }
    }

    const timeEl = root.find('time[datetime]').first();
    const datetime = timeEl.attr('datetime') || '';
    const meta = clean(root.find('.alert-meta').text()) || clean(timeEl.text());
    const classes = root.attr('class') || '';
    const unread = /(^|\s)is-unread(\s|$)/.test(classes);
    const key = alertKey({ url, title, datetime });
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ title, url, datetime, meta, unread, key });
  });

  return items;
}

export async function fetchAlerts() {
  if (!hasSessionCookie()) throw new AuthRequiredError('Нет сохранённой сессии YouGame');
  const page = await fetchPage('/account/alerts');
  if (!page.loggedIn || page.loginPage) throw new AuthRequiredError('Сессия YouGame недействительна');

  const alerts = parseAlerts(page.html);
  const navUser =
    page.username ||
    clean(cheerio.load(page.html)('.p-navgroup-link--user').first().text()) ||
    null;

  return { alerts, username: navUser, html: page.html };
}

export function rememberDebugHtml(html) {
  ensureDirs();
  fs.writeFileSync(config.debugAlertsPath, html, 'utf8');
  return config.debugAlertsPath;
}
