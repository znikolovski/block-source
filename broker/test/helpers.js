'use strict';

const crypto = require('node:crypto');
const { memoryState, memoryFiles } = require('../lib/storage');
const { buildDeps } = require('../lib/router');
const { createLogger } = require('../lib/http');
const { gitBlobSha } = require('../lib/crypto');

const KEY = crypto.randomBytes(32).toString('base64');
const NOW = Date.parse('2026-11-12T00:00:00Z');
const days = (n) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();

function jsonRes(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

const ADMIN = jwt({ user_id: 'admin@AdobeID', client_id: 'darkalley' });
const AUTHOR = jwt({ user_id: 'author@AdobeID', client_id: 'darkalley' });
const STRANGER = jwt({ user_id: 'stranger@AdobeID' });
const PAT = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';

function commit(sha, { message = `change ${sha}`, date = days(1), name = 'Sunny Wan', login = 'sunnywan' } = {}) {
  return {
    sha,
    html_url: `https://github.com/acme/site/commit/${sha}`,
    commit: {
      message,
      author: { name, email: `${login}@users.noreply.github.com`, date },
      committer: { name, date },
    },
    author: { login, avatar_url: `https://avatars.githubusercontent.com/${login}` },
  };
}

const sha = (c) => c.repeat(40);

/**
 * A fake repository:
 *  main (m) <- feature-cards (f: js change), css-only (c: css change),
 *  model-change (d: removes a model field), feature/slash (s), old-branch (o: 200 days old),
 *  other-block (x: touches hero only)
 */
function fixture() {
  const B = {
    main: sha('a'),
    'feature-cards': sha('b'),
    'css-only': sha('c'),
    'model-change': sha('d'),
    'feature/slash': sha('e'),
    'old-branch': sha('f'),
    'other-block': sha('1'),
  };
  const cmpFiles = {
    [B['feature-cards']]: [{ filename: 'blocks/cards/cards.js', status: 'modified' }, { filename: 'blocks/cards/cards.css', status: 'modified' }],
    [B['css-only']]: [{ filename: 'blocks/cards/cards.css', status: 'modified' }],
    [B['model-change']]: [{ filename: 'blocks/cards/_cards.json', status: 'modified' }],
    [B['feature/slash']]: [{ filename: 'blocks/cards/cards.css', status: 'modified' }],
    [B['old-branch']]: [{ filename: 'blocks/cards/cards.js', status: 'modified' }],
    [B['other-block']]: [{ filename: 'blocks/hero/hero.js', status: 'modified' }],
  };
  const headDate = { [B['old-branch']]: days(200) };
  const raw = {
    [`blocks/cards/cards.js@${B.main}`]: 'export default function decorate(block) { [...block.children].forEach((row) => { const [image, text] = [...row.children]; }); }',
    [`blocks/cards/cards.js@${B['feature-cards']}`]: 'export default function decorate(block) { [...block.children].forEach((row) => { const [image, text, cta] = [...row.children]; row.querySelector(\'a.button\'); }); }',
    [`blocks/cards/_cards.json@${B.main}`]: JSON.stringify({ models: [{ id: 'cards', fields: [{ component: 'text', name: 'title', label: 'Title' }, { component: 'reference', name: 'image', label: 'Image' }] }] }),
    [`blocks/cards/_cards.json@${B['model-change']}`]: JSON.stringify({ models: [{ id: 'cards', fields: [{ component: 'text', name: 'title', label: 'Title' }] }] }),
    [`scripts/scripts.js@${B.main}`]: 'import { loadArea } from \'./aem.js\';\nloadArea();\n',
    [`styles/styles.css@${B.main}`]: ':root { --brand: #eb1000; }\n',
    [`scripts/aem.js@${B.main}`]: 'export function loadArea() {}\n',
    [`.github/CODEOWNERS@${B.main}`]: '# owners\n* @acme/web\n/blocks/cards/ @sunnywan @acme/design\n',
    [`blocks/cards/README.md@${B.main}`]: '# Cards\n\nShows a grid of linked cards.\n\n| Column 1 | Column 2 |\n| --- | --- |\n| Image | Text |\n\n## Variants\n\n- `featured`\n',
  };
  return {
    B, cmpFiles, headDate, raw,
  };
}

function fakeFetch(fx, { log = [], overrides = [] } = {}) {
  const { B } = fx;
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    log.push({ url: url.toString(), auth, method: init.method || 'GET' });
    for (const [re, fn] of overrides) {
      if (re.test(url.toString())) return fn(url, init);
    }

    if (url.host === 'admin.da.live') {
      const t = auth.replace('Bearer ', '');
      if (url.pathname.startsWith('/list/acme/site')) {
        if (t === STRANGER) return jsonRes(403, {});
        return jsonRes(200, []);
      }
      if (url.pathname === '/config/acme/site/') {
        if (t === STRANGER) return jsonRes(403, {});
        const actions = t === ADMIN ? 'read,write' : 'read';
        return jsonRes(200, {
          ':type': 'multi-sheet',
          ':names': ['data'],
          data: { data: [{ key: 'github.owner', value: 'acme' }, { key: 'github.repo', value: 'site' }, { key: 'blocksource.protected', value: 'release-*' }] },
        }, { 'x-da-actions': `/acme/site=${actions}` });
      }
      return jsonRes(404, {});
    }
    if (url.host === 'ims-na1.adobelogin.com') return jsonRes(200, { email: 'admin@example.com', displayName: 'Ada Admin' });

    if (url.host === 'api.github.com') {
      if (auth !== `Bearer ${PAT}`) return jsonRes(401, { message: 'Bad credentials' });
      const p = url.pathname;
      if (p === '/repos/acme/site') {
        return jsonRes(200, { private: true, default_branch: 'main' }, { 'github-authentication-token-expiration': '2026-11-20 10:00:00 UTC' });
      }
      if (p === '/rate_limit') return jsonRes(200, { resources: { core: { limit: 5000, remaining: 4990, reset: 1800000000 } } });
      if (p === '/repos/acme/site/branches') {
        return jsonRes(200, Object.entries(B).map(([name, s]) => ({ name, commit: { sha: s }, protected: false })));
      }
      if (p === '/repos/acme/site/pulls') {
        return jsonRes(200, [{
          number: 7, title: 'Cards v2', html_url: 'https://github.com/acme/site/pull/7', state: 'open', draft: false, head: { ref: 'feature-cards', repo: { full_name: 'acme/site' } }, user: { login: 'sunnywan' },
        }]);
      }
      if (p === '/repos/acme/site/issues' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        fx.created = [...(fx.created || []), body];
        return jsonRes(201, {
          number: 42, html_url: 'https://github.com/acme/site/issues/42', labels: (body.labels || []).map((name) => ({ name })),
        });
      }
      if (p === '/repos/acme/site/issues') {
        const issue = (number, title, extra = {}) => ({
          number, title, html_url: `https://github.com/acme/site/issues/${number}`, updated_at: days(number), labels: [{ name: 'block:cards' }], user: { login: 'ada' }, ...extra,
        });
        return jsonRes(200, url.searchParams.get('labels') === 'block:cards'
          ? [issue(3, 'Cards overflow on mobile'), issue(4, 'A pull request', { pull_request: {} })]
          : []);
      }
      if (p === '/search/issues') {
        return jsonRes(200, {
          incomplete_results: false,
          items: [
            { number: 3, title: 'Cards overflow on mobile', html_url: 'https://github.com/acme/site/issues/3', updated_at: days(3), labels: [] },
            { number: 5, title: 'cards images are blurry', html_url: 'https://github.com/acme/site/issues/5', updated_at: days(1), labels: [] },
          ],
        });
      }
      let m = p.match(/^\/repos\/acme\/site\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
      if (m) {
        const head = m[2];
        const files = fx.cmpFiles[head] || [];
        return jsonRes(200, {
          status: 'ahead',
          ahead_by: 2,
          behind_by: 0,
          merge_base_commit: { sha: m[1] },
          commits: [commit(`${head.slice(0, 39)}0`, { date: fx.headDate[head] || days(2) }), commit(head, { date: fx.headDate[head] || days(1), message: 'Add CTA column' })],
          files,
        });
      }
      m = p.match(/^\/repos\/acme\/site\/commits\/([0-9a-f]+)$/);
      if (m) return jsonRes(200, { sha: m[1], files: [{ filename: 'blocks/cards/cards.js', status: 'modified' }, { filename: 'blocks/cards/README.md', status: 'modified' }] });
      if (p === '/repos/acme/site/commits') {
        const s = url.searchParams.get('sha');
        if (!s) return jsonRes(200, [commit(B.main)]);
        return jsonRes(200, [commit(B[s] || s, { message: 'Add CTA column' }), commit(sha('9'), { date: days(30) })]);
      }
      m = p.match(/^\/repos\/acme\/site\/contents\/(.+)$/);
      if (m) {
        const path = decodeURIComponent(m[1]);
        const ref = B[url.searchParams.get('ref')] || url.searchParams.get('ref');
        if (path === 'blocks/cards') {
          return jsonRes(200, ['cards.js', 'cards.css', 'README.md', '_cards.json'].map((name) => ({ name, path: `blocks/cards/${name}` })));
        }
        const accept = init.headers.Accept;
        const body = fx.raw[`${path}@${ref}`];
        if (body === undefined) return jsonRes(404, { message: 'Not Found' });
        if (accept.includes('raw')) return new Response(body, { status: 200 });
        return jsonRes(200, { sha: gitBlobSha(Buffer.from(body)) });
      }
      return jsonRes(404, { message: 'Not Found' });
    }
    if (/\.aem\.(live|page)$/.test(url.host)) {
      const ref = url.host.split('--')[0];
      const body = fx.raw[`${url.pathname.slice(1)}@${B[ref]}`];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

async function makeDeps({ fx = fixture(), fetchLog = [], overrides = [], config = {} } = {}) {
  const lines = [];
  const sink = {
    debug: (l) => lines.push(l), info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l), log: (l) => lines.push(l),
  };
  const state = memoryState(() => NOW);
  const files = memoryFiles();
  const deps = await buildDeps({ ENCRYPTION_KEY: KEY, LOG_LEVEL: 'debug' }, {
    state,
    files,
    now: () => NOW,
    fetch: fakeFetch(fx, { log: fetchLog, overrides }),
    config,
  });
  deps.log = createLogger(sink, deps.secrets, 'debug');
  return {
    deps, lines, state, files, fx, fetchLog,
  };
}

function request(method, path, { token, query = {}, body, origin = 'https://main--site--acme.aem.page' } = {}) {
  const headers = { origin };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    __ow_method: method.toLowerCase(),
    __ow_path: path,
    __ow_headers: headers,
    __ow_query: new URLSearchParams({ org: 'acme', site: 'site', ...query }).toString(),
    __ow_body: body ? JSON.stringify({ org: 'acme', site: 'site', ...body }) : undefined,
  };
}

const parse = (res) => ({ ...res, json: JSON.parse(res.body || '{}') });

module.exports = {
  KEY, NOW, ADMIN, AUTHOR, STRANGER, PAT, fixture, fakeFetch, makeDeps, request, parse, jsonRes, commit, sha, days,
};
