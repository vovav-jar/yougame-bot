import * as cheerio from 'cheerio';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function forumIdFromHref(href) {
  const m = /\/forums\/(\d+)(?:\/|$)/.exec(href || '');
  return m ? Number(m[1]) : null;
}

function parseSubList($, ol, out) {
  $(ol)
    .children('li')
    .each((_, li) => {
      const link = $(li).children('a.subNodeLink').first();
      if (!link.length) return;
      const href = link.attr('href') || '';
      const id = forumIdFromHref(href);
      if (!id) return;
      const title = clean(link.text());
      if (!title) return;
      const node = { id, title, href, children: [] };
      out.push(node);
      const nested = $(li).children('ol').first();
      if (nested.length) parseSubList($, nested, node.children);
    });
}

function parseNode($, el) {
  const link = $(el).find('.node-title a').first();
  const href = link.attr('href') || '';
  const id = forumIdFromHref(href);
  if (!id) return null;
  const node = {
    id,
    title: clean(link.text()),
    href,
    description: clean($(el).find('.node-description').first().text()),
    children: [],
  };
  const subList = $(el).find('.node-subNodesFlat ol').first();
  if (subList.length) parseSubList($, subList, node.children);
  return node;
}

/** Возвращает [{id, title, forums:[{id,title,href,description,children}]}]. */
export function parseForumTree(html) {
  const $ = cheerio.load(html);
  const sections = [];
  const seen = new Set();

  $('.block--category').each((_, block) => {
    const header = $(block).find('.block-header').first();
    const title = clean(header.text());
    if (!title) return;

    const catHref = header.find('a').attr('href') || '';
    const section = {
      id: Number((catHref.match(/\/categories\/(\d+)/) || [])[1]) || null,
      title,
      forums: [],
    };

    $(block)
      .find('.block-body > .node--forum')
      .each((__, el) => {
        const node = parseNode($, el);
        if (!node || seen.has(node.id)) return;
        seen.add(node.id);
        section.forums.push(node);
      });

    if (section.forums.length) sections.push(section);
  });

  return sections;
}

export function countForums(sections) {
  let count = 0;
  for (const section of sections) {
    const walk = (node) => {
      count += 1;
      node.children.forEach(walk);
    };
    section.forums.forEach(walk);
  }
  return count;
}

export function indexTree(sections) {
  const byId = new Map();
  sections.forEach((section, sectionIndex) => {
    const walk = (node, parentId, depth, path) => {
      const entry = {
        id: node.id,
        node,
        parentId,
        sectionIndex,
        depth,
        path: [...path, node.title],
      };
      byId.set(node.id, entry);
      for (const child of node.children) walk(child, node.id, depth + 1, entry.path);
    };
    section.forums.forEach((forum) => walk(forum, null, 0, [section.title]));
  });
  return byId;
}

export function subtreeIds(node) {
  const ids = [node.id];
  for (const child of node.children) ids.push(...subtreeIds(child));
  return ids;
}

export function selectionState(node, selected) {
  const ids = subtreeIds(node);
  let count = 0;
  for (const id of ids) if (selected.has(id)) count += 1;
  if (!count) return 'none';
  if (count === ids.length) return 'all';
  return 'some';
}

export function stateMark(selState) {
  return selState === 'all' ? '[x]' : selState === 'some' ? '[~]' : '[ ]';
}

export function pathOf(entry) {
  return entry.path.join(' › ');
}
