import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { getState } from './state.js';
import { selectionState, stateMark, subtreeIds } from './forums.js';
import { getSections, getIndex, entryFor } from './treeService.js';

const PAGE = 8;

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function formatTs(ts) {
  if (!ts) return 'ещё не было';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'только что';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function formatInterval(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

function markOf(node, selected) {
  return stateMark(selectionState(node, selected));
}

function sectionStats(section, selected) {
  let total = 0;
  let count = 0;
  const walk = (node) => {
    total += 1;
    if (selected.has(node.id)) count += 1;
    node.children.forEach(walk);
  };
  section.forums.forEach(walk);
  return { total, count };
}

function sectionSelected(section, selected) {
  return sectionStats(section, selected).count;
}

export function mainView() {
  const state = getState();
  const selected = new Set(state.selectedForums);
  const text = [
    '<b>YouGame Notifier</b>',
    `Аккаунт: ${state.sessionUsername ? esc(state.sessionUsername) : 'вход не выполнен'}`,
    `Уведомления: ${state.alertsEnabled ? 'включены' : 'выключены'} (раз в ${formatInterval(config.alertsIntervalSec)})`,
    `Новые темы: ${state.threadsEnabled ? 'включены' : 'выключены'} (раз в ${formatInterval(config.feedIntervalSec)})`,
    `Разделов выбрано: ${selected.size} из ${config.maxSelectedForums}`,
    '',
    'Бот следит за новыми темами в выбранных разделах и присылает уведомления с форума.',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`Уведомления: ${state.alertsEnabled ? 'вкл' : 'выкл'}`, 'ta')
    .text(`Новые темы: ${state.threadsEnabled ? 'вкл' : 'выкл'}`, 'tt')
    .row()
    .text(`Разделы (${selected.size})`, 'sections|0')
    .row()
    .text('Проверить сейчас', 'check')
    .text('Статус', 'status')
    .row();

  if (!state.sessionUsername) kb.text('Войти на форум', 'login').row();
  kb.text('Обновить список разделов', 'refresh');

  return { text, keyboard: kb };
}

export function sectionsView(page = 0) {
  const state = getState();
  const selected = new Set(state.selectedForums);
  const sections = getSections();

  if (!sections) {
    return {
      text: '<b>Разделы форума</b>\nСписок разделов ещё не загружен.',
      keyboard: new InlineKeyboard()
        .text('Загрузить разделы', 'refresh')
        .row()
        .text('Назад', 'menu'),
    };
  }

  const totalPages = Math.max(1, Math.ceil(sections.length / PAGE));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const slice = sections.slice(p * PAGE, p * PAGE + PAGE);

  const text = [
    '<b>Разделы форума</b>',
    `Выбрано: ${selected.size} из ${config.maxSelectedForums}`,
    '',
    'Выбери секцию, затем отметь нужные разделы. У разделов с подразделами откроется список.',
  ].join('\n');

  const kb = new InlineKeyboard();
  slice.forEach((section, i) => {
    const idx = p * PAGE + i;
    const count = sectionSelected(section, selected);
    const total = sectionStats(section, selected).total;
    kb.text(`${clip(section.title, 40)} (${count}/${total})`, `sv|${idx}|0`).row();
  });

  if (totalPages > 1) {
    if (p > 0) kb.text('Назад', `sections|${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, 'noop');
    if (p < totalPages - 1) kb.text('Дальше', `sections|${p + 1}`);
    kb.row();
  }
  kb.text('В главное меню', 'menu');

  return { text, keyboard: kb };
}

export function sectionView(sectionIndex, page = 0) {
  const sections = getSections();
  const section = sections?.[sectionIndex];
  if (!section) {
    return {
      text: 'Секция не найдена. Обнови список разделов.',
      keyboard: new InlineKeyboard().text('К разделам', 'sections|0'),
    };
  }

  const state = getState();
  const selected = new Set(state.selectedForums);
  const stats = sectionStats(section, selected);
  const totalPages = Math.max(1, Math.ceil(section.forums.length / PAGE));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const slice = section.forums.slice(p * PAGE, p * PAGE + PAGE);

  const text = [
    `<b>${esc(section.title)}</b>`,
    `Выбрано в секции: ${stats.count} из ${stats.total}`,
    '',
    'Раздел с подразделами открывается нажатием. Листовой раздел выбирается сразу.',
  ].join('\n');

  const kb = new InlineKeyboard();
  for (const forum of slice) {
    const mark = markOf(forum, selected);
    if (forum.children.length) {
      kb.text(`${mark} ${clip(forum.title, 45)} >`, `nv|${forum.id}|0`).row();
    } else {
      kb.text(`${mark} ${clip(forum.title, 50)}`, `tg|${forum.id}|s|${sectionIndex}|${p}`).row();
    }
  }

  if (totalPages > 1) {
    if (p > 0) kb.text('Назад', `sv|${sectionIndex}|${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, 'noop');
    if (p < totalPages - 1) kb.text('Дальше', `sv|${sectionIndex}|${p + 1}`);
    kb.row();
  }
  kb.text('К секциям', 'sections|0').text('В меню', 'menu');

  return { text, keyboard: kb };
}

export function nodeView(nodeId, page = 0) {
  const entry = entryFor(nodeId);
  if (!entry) {
    return {
      text: 'Раздел не найден. Обнови список разделов.',
      keyboard: new InlineKeyboard().text('К разделам', 'sections|0'),
    };
  }
  const node = entry.node;
  const state = getState();
  const selected = new Set(state.selectedForums);
  const ids = subtreeIds(node);
  const selectedCount = ids.filter((id) => selected.has(id)).length;
  const totalPages = Math.max(1, Math.ceil(node.children.length / PAGE));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const slice = node.children.slice(p * PAGE, p * PAGE + PAGE);

  const text = [
    `<b>${esc(clip(entry.path.join(' › '), 200))}</b>`,
    `Выбрано: ${selectedCount} из ${ids.length}`,
    '',
    node.children.length ? 'Отметь подразделы целиком или открой вложенные.' : 'У раздела нет подразделов.',
  ].join('\n');

  const kb = new InlineKeyboard();
  for (const child of slice) {
    const mark = markOf(child, selected);
    if (child.children.length) {
      kb.text(`${mark} ${clip(child.title, 45)} >`, `nv|${child.id}|0`).row();
    } else {
      kb.text(`${mark} ${clip(child.title, 50)}`, `tg|${child.id}|n|${nodeId}|${p}`).row();
    }
  }

  if (totalPages > 1) {
    if (p > 0) kb.text('Назад', `nv|${nodeId}|${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, 'noop');
    if (p < totalPages - 1) kb.text('Дальше', `nv|${nodeId}|${p + 1}`);
    kb.row();
  }

  kb.text(`Выбрать весь раздел (${ids.length})`, `sa|${nodeId}|${p}`).row();
  kb.text('Снять выделение раздела', `sn|${nodeId}|${p}`).row();

  if (entry.parentId) kb.text('Назад', `nv|${entry.parentId}|0`);
  else kb.text('К секциям', 'sections|0');
  kb.text('В меню', 'menu');

  return { text, keyboard: kb };
}

export function statusView() {
  const state = getState();
  const session =
    state.sessionOk === true ? 'активна' : state.sessionOk === false ? 'истекла' : 'не проверялась';

  const text = [
    '<b>Статус</b>',
    `Аккаунт: ${state.sessionUsername ? esc(state.sessionUsername) : 'вход не выполнен'}`,
    `Сессия: ${session}${state.sessionCheckedAt ? ` (проверена ${formatTs(state.sessionCheckedAt)})` : ''}`,
    '',
    `Новые темы: ${state.threadsEnabled ? 'вкл' : 'выкл'}, последняя проверка — ${formatTs(state.lastFeedAt)}`,
    `Уведомления: ${state.alertsEnabled ? 'вкл' : 'выкл'}, последняя проверка — ${formatTs(state.lastAlertsAt)}`,
    `Разделов выбрано: ${state.selectedForums.length} из ${config.maxSelectedForums}`,
    '',
    `Последняя ошибка тем: ${state.lastFeedError ? esc(clip(state.lastFeedError, 160)) : 'нет'}`,
    `Последняя ошибка уведомлений: ${state.lastAlertsError ? esc(clip(state.lastAlertsError, 160)) : 'нет'}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('Проверить сессию', 'sess')
    .text('Проверить сейчас', 'check')
    .row()
    .text('Войти заново', 'login')
    .text('В меню', 'menu');

  return { text, keyboard: kb };
}
