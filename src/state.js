import fs from 'node:fs';
import { config, ensureDirs } from './config.js';
import { writeFileAtomic } from './atomic.js';

const DEFAULTS = {
  version: 1,
  ownerId: null,
  chatId: null,
  alertsEnabled: true,
  threadsEnabled: true,
  selectedForums: [],
  seededForums: [],
  forumMax: {},
  forumTitles: {},
  seenThreads: [],
  seenAlerts: [],
  alertsSeeded: false,
  sessionUsername: null,
  sessionOk: null,
  sessionCheckedAt: 0,
  authNoticeAt: 0,
  feedNoticeAt: 0,
  emptyAlertsStreak: 0,
  emptyWarnedAt: 0,
  lastFeedAt: 0,
  lastAlertsAt: 0,
  lastFeedError: null,
  lastAlertsError: null,
  createdAt: Date.now(),
};

let state = null;

export function getState() {
  if (state) return state;
  ensureDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
    state = { ...structuredClone(DEFAULTS), ...parsed };
  } catch {
    state = structuredClone(DEFAULTS);
  }
  return state;
}

export function saveState() {
  if (!state) return;
  ensureDirs();
  writeFileAtomic(config.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function selectedSet() {
  return new Set(getState().selectedForums);
}

export function markSeen(kind, key, cap) {
  const s = getState();
  const list = kind === 'threads' ? s.seenThreads : s.seenAlerts;
  if (!list.includes(key)) list.push(key);
  if (list.length > cap) list.splice(0, list.length - cap);
}

export function isSeen(kind, key) {
  const s = getState();
  return (kind === 'threads' ? s.seenThreads : s.seenAlerts).includes(key);
}

export function loadTree() {
  try {
    const data = JSON.parse(fs.readFileSync(config.treePath, 'utf8'));
    if (Array.isArray(data.sections) && data.sections.length) return data;
  } catch {
    /* кэша ещё нет */
  }
  return null;
}

export function saveTree(sections) {
  ensureDirs();
  writeFileAtomic(config.treePath, JSON.stringify({ updatedAt: Date.now(), sections }, null, 2));
}
