/**
 * Shared by the dry-run harness and the canvas agent.
 * Authored HTML from the editor is inserted as a block, so it is cleaned first:
 * no scripts or embeds, no inline event handlers, no javascript: URLs.
 */
const DROP = 'script, iframe, object, embed, link, meta, base, style';
const URL_ATTRS = ['href', 'src', 'srcset', 'action', 'formaction', 'xlink:href'];
const EDITOR_ATTR = /^data-(prose-index|block-index|image-index|image-version|cursor)/;

export function cleanElement(root) {
  root.querySelectorAll(DROP).forEach((el) => el.remove());
  [root, ...root.querySelectorAll('*')].forEach((el) => {
    [...el.attributes].forEach(({ name, value }) => {
      const n = name.toLowerCase();
      if (n.startsWith('on') || EDITOR_ATTR.test(n) || n === 'contenteditable' || n === 'draggable') {
        el.removeAttribute(name);
      } else if (URL_ATTRS.includes(n) && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
        el.removeAttribute(name);
      }
    });
  });
  return root;
}

/** Parses block HTML into a single element owned by `doc`. */
export function blockFromHtml(html, doc = document) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = String(html || '').trim();
  const el = tpl.content.firstElementChild;
  if (!el) return null;
  return cleanElement(doc.importNode(el, true));
}

export function words(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)) || [];
}

/** What the dry run compares before and after decoration. */
export function measure(el) {
  // Tokenize per text node: textContent joins adjacent cells ("world" + "link" -> "worldlink").
  const found = [];
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) found.push(...words(n.nodeValue));
  return {
    words: found,
    links: el.querySelectorAll('a[href]').length,
    images: el.querySelectorAll('img').length,
  };
}
