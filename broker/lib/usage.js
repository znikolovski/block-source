'use strict';

const { pool } = require('./util');
const { usagePath } = require('./summary');

const SKIP_CLASSES = new Set(['metadata', 'section-metadata', 'library-metadata']);
const PAGES_PER_BLOCK = 50;
// Block library documentation, templates and drafts are not pages authors publish.
const SKIP_FOLDERS = /^\/(blocks|library|templates|drafts|tools)(\/|$)/;

/**
 * Blocks used on a page, with their variants: the first class of every div that is a direct
 * child of a section (main > div > div[class]) is the block, the other classes are variants.
 * A small tag scanner, so no DOM library is needed.
 */
function blocksInHtml(html) {
  const names = new Map();
  const start = html.search(/<main[\s>]/i);
  if (start < 0) return names;
  const end = html.indexOf('</main>', start);
  const main = html.slice(start, end < 0 ? undefined : end);
  const re = /<(\/?)div\b([^>]*)>/gi;
  let depth = 0;
  let m = re.exec(main);
  while (m) {
    if (m[1]) depth -= 1;
    else {
      depth += 1;
      if (depth === 2) {
        const cls = (m[2].match(/class\s*=\s*"([^"]*)"/i) || [])[1];
        const [name, ...variants] = cls ? cls.trim().toLowerCase().split(/\s+/) : [];
        if (name && !SKIP_CLASSES.has(name)) {
          if (!names.has(name)) names.set(name, new Set());
          variants.forEach((v) => names.get(name).add(v));
        }
      }
    }
    if (depth < 0) break;
    m = re.exec(main);
  }
  return names;
}

const blockNamesInHtml = (html) => new Set(blocksInHtml(html).keys());

async function daJson(deps, token, path, continuation) {
  const headers = { Authorization: `Bearer ${token}` };
  if (continuation) headers['da-continuation-token'] = continuation;
  const res = await deps.fetch(`${deps.config.daAdminUrl}${path}`, { headers });
  if (!res.ok) throw new Error(`DA ${res.status} for ${path}`);
  return { data: await res.json(), next: res.headers.get('da-continuation-token') };
}

/**
 * Crawls the site in DA, counts the pages that use each block, and stores the result.
 * Runs nightly with a service token, or on demand by an administrator with a time budget.
 */
async function scanUsage(deps, {
  org, site, token, budgetMs = 50000, maxPages = 5000,
}) {
  const started = deps.now();
  const prefix = `/${org}/${site}`;
  const folders = [''];
  const pages = [];
  let complete = true;

  while (folders.length) {
    if (deps.now() - started > budgetMs / 2) {
      complete = false;
      break;
    }
    const batch = folders.splice(0, 8);
    // eslint-disable-next-line no-await-in-loop
    await pool(batch, 4, async (folder) => {
      let next = null;
      do {
        // eslint-disable-next-line no-await-in-loop
        const res = await daJson(deps, token, `/list${prefix}${folder}`, next);
        next = res.next;
        (Array.isArray(res.data) ? res.data : []).forEach((e) => {
          if (!e.name || e.name.startsWith('.')) return;
          const rel = e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path;
          if (SKIP_FOLDERS.test(rel)) return;
          if (!e.ext) folders.push(rel);
          else if (e.ext === 'html' && pages.length < maxPages) pages.push(rel);
        });
      } while (next);
    });
  }

  const blocks = {};
  let scanned = 0;
  await pool(pages, 8, async (page) => {
    if (deps.now() - started > budgetMs) {
      complete = false;
      return;
    }
    try {
      const res = await deps.fetch(`${deps.config.daAdminUrl}/source${prefix}${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      scanned += 1;
      const path = page.replace(/\.html$/, '').replace(/\/index$/, '/');
      blocksInHtml(await res.text()).forEach((variants, name) => {
        blocks[name] = blocks[name] || { count: 0, pages: [], variants: {} };
        blocks[name].count += 1;
        if (blocks[name].pages.length < PAGES_PER_BLOCK) blocks[name].pages.push(path);
        // Pages per variant; "default" counts pages that use the block without one.
        (variants.size ? [...variants] : ['default']).forEach((v) => {
          blocks[name].variants[v] = (blocks[name].variants[v] || 0) + 1;
        });
      });
    } catch (e) {
      deps.log.info('usage: page failed', page, e.message);
    }
  });

  const result = {
    scannedAt: new Date(deps.now()).toISOString(),
    complete: complete && pages.length < maxPages,
    pages: scanned,
    blocks,
  };
  await deps.files.writeJson(usagePath(org, site), result);
  return result;
}

/** Server-to-server IMS token for the nightly job. The technical account needs read access in DA. */
async function serviceToken(deps) {
  const { imsClientId, imsClientSecret, imsScopes, imsUrl } = deps.config;
  if (!imsClientId || !imsClientSecret) return null;
  const res = await deps.fetch(`${imsUrl}/ims/token/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: imsClientId,
      client_secret: imsClientSecret,
      scope: imsScopes,
    }).toString(),
  });
  if (!res.ok) throw new Error(`IMS token request failed with ${res.status}`);
  const body = await res.json();
  deps.secrets.add(body.access_token);
  return body.access_token;
}

module.exports = {
  blocksInHtml, blockNamesInHtml, scanUsage, serviceToken,
};
