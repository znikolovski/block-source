/**
 * Block Source canvas agent. Runs inside the page preview (the canvas), applies a block
 * from a branch to this view only, and reverts it. Nothing is saved, published or shared:
 * a reload of the canvas shows the page as it is.
 *
 * The site loads this script in the canvas (see README). The plugin cannot reach the canvas
 * window directly, so the agent opens bridge.html from the origin it was loaded from, and the
 * plugin talks to the bridge over a BroadcastChannel (see lib/canvas.js). When the agent is
 * served from the canvas origin itself, it joins the channel directly.
 */
import { blockFromHtml } from './lib/sanitize.js';
import { CHANNEL, TAB_KEY } from './lib/canvas.js';

const HOST = /^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.(aem\.page|aem\.live|preview\.da\.live|stage-preview\.da\.live)$/;
const OWN_URL = new URL(import.meta.url);
const applied = new Map();
let banner;

/** The site this canvas shows, from its hostname. Null on a local dev server. */
export function canvasSite(hostname = window.location.hostname) {
  const m = HOST.exec(hostname);
  return m ? { site: m[2], org: m[3] } : null;
}

function instancesOf(name) {
  const decorated = [...document.querySelectorAll(`main [data-block-name="${CSS.escape(name)}"]`)];
  if (decorated.length) return decorated;
  return [...document.querySelectorAll(`main > div > div.${CSS.escape(name)}, main > div > div > div.${CSS.escape(name)}`)];
}

function cssLinks(name) {
  return [...document.querySelectorAll('head link[rel="stylesheet"]')]
    .filter((l) => !l.dataset.blockSource && new URL(l.href, window.location.href).pathname.endsWith(`/blocks/${name}/${name}.css`));
}

function renderBanner() {
  if (!applied.size) {
    banner?.remove();
    banner = null;
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:12px;align-items:center;'
      + 'padding:8px 12px;border-radius:8px;background:#1d1d1d;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    const text = document.createElement('span');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Revert';
    button.style.cssText = 'font:inherit;padding:4px 10px;border-radius:14px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer';
    // eslint-disable-next-line no-use-before-define
    button.addEventListener('click', () => revertAll());
    banner.append(text, button);
    document.body.append(banner);
  }
  const n = applied.size;
  const branches = [...new Set([...applied.values()].map((a) => a.branch))].join(', ');
  banner.firstChild.textContent = `Previewing ${n} block${n === 1 ? '' : 's'} from ${branches}. Only you see this, until you reload.`;
}

async function decorate(el, name) {
  let aem = {};
  try {
    // Resolved against the canvas, not this script's host, so it is the page's own aem.js instance.
    aem = await import(new URL(`${window.hlx?.codeBasePath || ''}/scripts/aem.js`, window.location.origin).href);
  } catch {
    // site without aem.js
  }
  if (aem.decorateBlock) aem.decorateBlock(el);
  else {
    el.classList.add('block');
    el.dataset.blockName = name;
    el.parentElement?.classList.add(`${name}-wrapper`);
  }
  try {
    aem.decorateIcons?.(el);
  } catch {
    // optional
  }
}

async function importModule(moduleUrl, code) {
  try {
    return await import(moduleUrl);
  } catch (e) {
    if (!code) throw Object.assign(e, { phase: 'import' });
  }
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function restoreCss(name) {
  const stillPreviewed = [...applied.values()].some((a) => a.block === name);
  if (stillPreviewed) return;
  document.querySelectorAll(`link[data-block-source="${CSS.escape(name)}"]`).forEach((l) => l.remove());
  cssLinks(name).forEach((l) => { l.disabled = false; });
}

export async function revert(id) {
  const entry = applied.get(id);
  if (!entry) return false;
  entry.el.replaceWith(entry.original);
  applied.delete(id);
  restoreCss(entry.block);
  renderBanner();
  return true;
}

export async function revertAll() {
  await Promise.all([...applied.keys()].map((id) => revert(id)));
  return true;
}

export function list() {
  return [...applied.entries()].map(([id, a]) => ({
    id, block: a.block, instance: a.instance, branch: a.branch, sha: a.sha,
  }));
}

export async function apply({
  block, instance = 0, html, moduleUrl, cssUrl, code, branch, sha,
}) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(block || '')) throw new Error('Invalid block name.');
  const id = `${block}:${instance}`;
  if (applied.has(id)) await revert(id);
  const target = instancesOf(block)[instance];
  if (!target) throw Object.assign(new Error('The block was not found on the canvas.'), { phase: 'find' });
  const el = blockFromHtml(html);
  if (!el) throw new Error('No block content.');
  el.dataset.blockSourceRef = branch;
  target.replaceWith(el);
  const entry = {
    el, original: target, block, instance, branch, sha,
  };
  applied.set(id, entry);
  try {
    await decorate(el, block);
    const mod = await importModule(moduleUrl, code);
    if (cssUrl && !document.querySelector(`link[data-block-source="${CSS.escape(block)}"][href="${CSS.escape(cssUrl)}"]`)) {
      document.querySelectorAll(`link[data-block-source="${CSS.escape(block)}"]`).forEach((l) => l.remove());
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssUrl;
      link.dataset.blockSource = block;
      document.head.append(link);
    }
    // The old styles stay on when another instance of the block still uses them.
    const others = instancesOf(block).filter((b) => !b.dataset.blockSourceRef);
    if (!others.length) cssLinks(block).forEach((l) => { l.disabled = true; });
    await mod.default(el);
    el.dataset.blockStatus = 'loaded';
    el.style.outline = '2px dashed #e68619';
    el.style.outlineOffset = '4px';
    renderBanner();
    return { id, ok: true };
  } catch (e) {
    await revert(id);
    throw Object.assign(new Error(e.message), { phase: e.phase || 'decorate' });
  }
}

/** The colour behind an element: its own, or the nearest ancestor's that is not transparent. */
function backdrop(node) {
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return '#fff';
}

let shotLib;

/** Loads lazy images in the block, so the screenshot shows them even when they are below the fold. */
async function loadImages(el, timeoutMs = 8000) {
  const imgs = [...el.querySelectorAll('img')];
  imgs.forEach((img) => {
    if (img.loading === 'lazy') img.loading = 'eager';
  });
  const settle = (img) => (img.complete && img.naturalWidth ? null : img.decode().catch(() => {}));
  await Promise.race([
    Promise.all(imgs.map(settle)),
    new Promise((r) => { setTimeout(r, timeoutMs); }),
  ]);
}

/**
 * A JPEG of one block instance as the canvas shows it (with any applied preview), as a data
 * URL no larger than `maxBytes`. Rendered from the DOM, so it needs no screen-capture permission.
 */
export async function capture({ block, instance = 0, maxBytes = 550 * 1024 } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(block || '')) throw new Error('Invalid block name.');
  const el = instancesOf(block)[instance];
  if (!el) throw Object.assign(new Error('The block was not found on the canvas.'), { phase: 'find' });
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) throw Object.assign(new Error('The block is not visible on the canvas.'), { phase: 'find' });
  shotLib = shotLib || import(new URL('./vendor/modern-screenshot.js', OWN_URL).href);
  const [{ domToJpeg }] = await Promise.all([shotLib, loadImages(el)]);
  const { outline } = el.style;
  el.style.outline = '';
  try {
    let scale = Math.min(2, window.devicePixelRatio || 1, 1600 / rect.width, 4000 / rect.height);
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const dataUrl = await domToJpeg(el, {
        scale,
        quality: 0.85,
        backgroundColor: backdrop(el),
        timeout: 15000,
        // The library inlines each <img> but keeps <picture> <source>s, which would win and stay unloaded.
        onCloneEachNode: (node) => {
          if (node.nodeName === 'PICTURE') node.querySelectorAll(':scope > source').forEach((s) => s.remove());
        },
      });
      const bytes = Math.ceil(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);
      if (bytes <= maxBytes || attempt >= 4) {
        return {
          dataUrl, bytes, width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), fits: bytes <= maxBytes,
        };
      }
      scale *= 0.7;
    }
  } finally {
    el.style.outline = outline;
  }
}

const agent = {
  version: 2, apply, revert, revertAll, list, capture,
};
window.blockSourceAgent = agent;

/** Handles one plugin command. Returns the reply, or null when the command is not for this canvas. */
export async function handle(msg, own = canvasSite()) {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('block-source:agent-') || msg.type === 'block-source:agent-reply') return null;
  if (own && (msg.org !== own.org || msg.site !== own.site)) return null;
  const base = {
    type: 'block-source:agent-reply', id: msg.id, tab: msg.tab, org: msg.org, site: msg.site,
  };
  if (msg.type === 'block-source:agent-hello') return { ...base, ok: true, result: { hello: true, path: window.location.pathname } };
  const methods = {
    'block-source:agent-apply': () => apply(msg.args || {}),
    'block-source:agent-revert': () => revert(msg.args && msg.args.id),
    'block-source:agent-revert-all': () => revertAll(),
    'block-source:agent-list': () => list(),
    'block-source:agent-capture': () => capture(msg.args || {}),
  };
  const fn = methods[msg.type];
  if (!fn) return null;
  try {
    return { ...base, ok: true, result: await fn() };
  } catch (err) {
    return {
      ...base, ok: false, error: err.message, phase: err.phase || null,
    };
  }
}

/** Tells a panel that is already open that the agent has started, so it does not wait for its next retry. */
export function readyAnnouncement(own = canvasSite()) {
  return own ? {
    type: 'block-source:agent-reply', id: 'ready', event: 'ready', ok: true, org: own.org, site: own.site,
  } : null;
}

function joinChannel() {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async ({ data }) => {
    let tab = null;
    try {
      tab = window.sessionStorage.getItem(TAB_KEY);
    } catch {
      // storage blocked
    }
    if (!data || !data.tab || data.tab !== tab) return;
    const reply = await handle(data);
    if (reply) channel.postMessage(reply);
  };
  let tab = null;
  try {
    tab = window.sessionStorage.getItem(TAB_KEY);
  } catch {
    // storage blocked
  }
  const ready = readyAnnouncement();
  if (ready && tab) channel.postMessage({ ...ready, tab });
}

function openBridge() {
  const frame = document.createElement('iframe');
  frame.src = new URL('./bridge.html', OWN_URL).href;
  frame.title = 'Block Source';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow || e.origin !== OWN_URL.origin) return;
    if (e.data && e.data.type === 'block-source:bridge-ready') {
      const ready = readyAnnouncement();
      if (ready) frame.contentWindow.postMessage(ready, OWN_URL.origin);
      return;
    }
    const reply = await handle(e.data);
    if (reply) frame.contentWindow.postMessage(reply, OWN_URL.origin);
  });
  (document.body || document.documentElement).append(frame);
}

if (window.top !== window && !window.blockSourceAgentStarted) {
  window.blockSourceAgentStarted = true;
  if (OWN_URL.origin === window.location.origin) joinChannel();
  else openBridge();
}
