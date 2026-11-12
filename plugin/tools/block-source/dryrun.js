/**
 * Gate 3 harness. Loaded in a hidden iframe, either on the branch origin
 * ({branch}--site--org.aem.page) or on the plugin origin, which may be the plugin's own
 * hosting. Global styles and aem.js always come from the branch (codeOrigin). It decorates the author's
 * block with the branch code and reports what survived. Nothing is shown to anyone.
 */
import { blockFromHtml, measure } from './lib/sanitize.js';

const HOST = /^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.(aem\.page|aem\.live|preview\.da\.live|stage-preview\.da\.live)$/;

export function allowedParent(origin, own = window.location) {
  if (origin === own.origin) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) {
    return ['localhost', '127.0.0.1'].includes(own.hostname);
  }
  const a = HOST.exec(u.hostname);
  const b = HOST.exec(own.hostname);
  return Boolean(u.protocol === 'https:' && a && b && a[2] === b[2] && a[3] === b[3]);
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const frame = () => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); });

function withTimeout(promise, ms, label) {
  return Promise.race([promise, wait(ms).then(() => { throw Object.assign(new Error(`${label} timed out`), { timeout: true }); })]);
}

function loadCss(href) {
  return new Promise((resolve) => {
    if (!href) {
      resolve(false);
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve(true);
    link.onerror = () => resolve(false);
    document.head.append(link);
    setTimeout(() => resolve(false), 3000);
  });
}

async function siteHelpers(codeOrigin = '') {
  try {
    const aem = await import(`${codeOrigin}/scripts/aem.js`);
    if (codeOrigin && window.hlx) window.hlx.codeBasePath = codeOrigin;
    return aem;
  } catch {
    return {};
  }
}

function decorateFallback(block, name) {
  block.classList.add('block');
  block.dataset.blockName = name;
  block.dataset.blockStatus = 'initialized';
  block.parentElement.classList.add(`${name}-wrapper`);
  block.closest('.section')?.classList.add(`${name}-container`);
}

export async function run({
  block: name, html, moduleUrl, cssUrl, code, codeOrigin = '', timeoutMs = 8000,
}) {
  const started = performance.now();
  const errors = [];
  const onError = (e) => errors.push(String((e.error && e.error.message) || e.message || e.reason || e));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  const main = document.querySelector('main');
  main.replaceChildren();
  const section = document.createElement('div');
  section.className = 'section';
  const wrapper = document.createElement('div');
  section.append(wrapper);
  main.append(section);
  const block = blockFromHtml(html);
  if (!block) return { ok: false, phase: 'input', error: 'No block content.' };
  wrapper.append(block);
  const before = measure(block);

  const done = (extra) => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onError);
    return { durationMs: Math.round(performance.now() - started), before, ...extra };
  };

  await loadCss(`${codeOrigin}/styles/styles.css`);
  const aem = await siteHelpers(codeOrigin);
  try {
    if (aem.decorateBlock) aem.decorateBlock(block);
    else decorateFallback(block, name);
    if (aem.decorateIcons) aem.decorateIcons(block);
  } catch {
    decorateFallback(block, name);
  }

  let mod;
  let blobUrl;
  try {
    let url = moduleUrl;
    if (code) {
      blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      url = blobUrl;
    }
    mod = await withTimeout(import(url), 5000, 'import');
  } catch (e) {
    return done({ ok: false, phase: 'import', error: e.message });
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
  await loadCss(cssUrl);
  try {
    if (typeof mod.default !== 'function') throw new Error('The block module has no default export.');
    await withTimeout(Promise.resolve(mod.default(block)), timeoutMs, 'decorate');
    block.dataset.blockStatus = 'loaded';
  } catch (e) {
    await frame();
    return done({
      ok: false, phase: 'decorate', timedOut: Boolean(e.timeout), error: e.message, after: { ...measure(block), height: block.getBoundingClientRect().height },
    });
  }
  await frame();
  await wait(50);
  const after = { ...measure(block), height: Math.round(block.getBoundingClientRect().height) };
  if (errors.length) return done({ ok: false, phase: 'runtime', error: errors[0], after });
  return done({ ok: true, after });
}

if (window.parent !== window) {
  window.addEventListener('message', async (e) => {
    if (e.source !== window.parent || !allowedParent(e.origin)) return;
    if (!e.data || e.data.type !== 'block-source:dryrun') return;
    let result;
    try {
      result = await run(e.data);
    } catch (err) {
      result = { ok: false, phase: 'harness', error: err.message };
    }
    window.parent.postMessage({ type: 'block-source:dryrun-result', id: e.data.id, ...result }, e.origin);
  });
  window.parent.postMessage({ type: 'block-source:harness-ready' }, '*');
}
