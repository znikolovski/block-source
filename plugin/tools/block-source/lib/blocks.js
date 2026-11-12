import { cleanElement } from './sanitize.js';

/** Tables DA does not count in selection.blockIndex. library-metadata IS counted. */
const NOT_COUNTED = new Set(['metadata', 'section-metadata', 'section metadata']);
const NOT_BLOCKS = new Set(['metadata', 'section-metadata', 'library-metadata']);

export const blockName = (el) => (el.classList[0] || '').toLowerCase();

function sectionsOf(doc) {
  const main = doc.querySelector('main');
  if (main) return [...main.children].filter((el) => el.tagName === 'DIV');
  // .plain.html has the sections at the top level
  return [...(doc.body || doc).children].filter((el) => el.tagName === 'DIV');
}

/**
 * Every block on the page, in document order:
 * { el, name, variants, ordinal (matches DA selection.blockIndex), instance (nth of this name) }
 */
export function listBlocks(doc) {
  const out = [];
  const seen = new Map();
  let ordinal = 0;
  sectionsOf(doc).forEach((section) => {
    [...section.children].filter((el) => el.tagName === 'DIV' && el.classList.length).forEach((el) => {
      const name = blockName(el);
      const full = el.className.trim().toLowerCase().replace(/\s+/g, ' ');
      const counted = !NOT_COUNTED.has(name) && !NOT_COUNTED.has(full);
      if (counted) ordinal += 1;
      if (!counted || NOT_BLOCKS.has(name)) return;
      const instance = seen.get(name) || 0;
      seen.set(name, instance + 1);
      out.push({
        el, name, variants: [...el.classList].slice(1), ordinal: counted ? ordinal - 1 : null, instance,
      });
    });
  });
  return out;
}

export function blockAtIndex(doc, blockIndex) {
  if (blockIndex === null || blockIndex === undefined || blockIndex < 0) return null;
  return listBlocks(doc).find((b) => b.ordinal === blockIndex) || null;
}

/** Authored markup of a block without editor attributes. */
export function authoredHtml(el) {
  return cleanElement(el.cloneNode(true)).outerHTML;
}

/** Rows and the widest row, for author-language reasons. */
export function contentShape(el) {
  const rows = [...el.children];
  return { rows: rows.length, maxCells: rows.reduce((n, r) => Math.max(n, r.children.length), 0) };
}

export function describe(block) {
  if (!block) return null;
  return {
    name: block.name,
    variants: block.variants,
    instance: block.instance,
    ordinal: block.ordinal,
    html: authoredHtml(block.el),
    shape: contentShape(block.el),
  };
}

export function parseHtml(html) {
  return new DOMParser().parseFromString(String(html || ''), 'text/html');
}
