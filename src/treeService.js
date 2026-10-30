import { loadTree, saveTree, getState, saveState } from './state.js';
import { fetchTree } from './yougame.js';
import { indexTree } from './forums.js';

let sections = null;
let index = null;
let updatedAt = 0;

const WEEK = 7 * 24 * 60 * 60 * 1000;

function applyTree(nextSections, at) {
  sections = nextSections;
  index = indexTree(nextSections);
  updatedAt = at;
  const state = getState();
  for (const [id, entry] of index) state.forumTitles[id] = entry.node.title;
  saveState();
}

export function initTreeFromCache() {
  const cached = loadTree();
  if (!cached) return false;
  applyTree(cached.sections, cached.updatedAt || 0);
  return true;
}

export function getSections() {
  return sections;
}

export function getIndex() {
  return index;
}

export function getUpdatedAt() {
  return updatedAt;
}

export function entryFor(id) {
  return index?.get(Number(id)) || null;
}

export function titleFor(id) {
  return entryFor(id)?.node.title || getState().forumTitles[id] || `Раздел ${id}`;
}

export async function refreshTree() {
  const next = await fetchTree();
  saveTree(next);
  applyTree(next, Date.now());
  return next;
}

export async function ensureTree() {
  if (sections) return sections;
  if (initTreeFromCache()) {
    if (Date.now() - updatedAt > WEEK) refreshTree().catch(() => undefined);
    return sections;
  }
  return refreshTree();
}
