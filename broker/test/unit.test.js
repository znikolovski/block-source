'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  seal, open, gitBlobSha, loadMasterKey,
} = require('../lib/crypto');
const { redact, createLogger, isAllowedOrigin } = require('../lib/http');
const { createGitHub } = require('../lib/github');
const { validateCredential } = require('../lib/validate');
const { diffModels, compareContracts, flattenFields } = require('../lib/contract');
const { classifyChanges, domSignature, signatureHints } = require('../lib/signature');
const { parseReadme, parseHeaderComment } = require('../lib/summary');
const { previewability, touchesBlock } = require('../lib/blocks');
const { isProtected } = require('../lib/branches');
const { blockNamesInHtml, blocksInHtml, scanUsage } = require('../lib/usage');
const { codeOwnersFor } = require('../lib/insights');
const { rewriteImports } = require('../lib/module');
const { parseSiteConfig, parseDaActions } = require('../lib/auth');
const { createCache } = require('../lib/cache');
const { memoryState } = require('../lib/storage');
const { rateLimit } = require('../lib/util');
const { jsonRes } = require('./helpers');

test('envelope encryption round-trips and is bound to its site', () => {
  const key = loadMasterKey(crypto.randomBytes(32).toString('base64'));
  const env = seal('github_pat_secret', key, 'block-source:acme/site');
  assert.ok(!JSON.stringify(env).includes('github_pat_secret'));
  assert.equal(open(env, key, 'block-source:acme/site'), 'github_pat_secret');
  assert.throws(() => open(env, key, 'block-source:acme/other'));
  assert.throws(() => open(env, loadMasterKey(crypto.randomBytes(32).toString('base64')), 'block-source:acme/site'));
  assert.throws(() => loadMasterKey('short'));
});

test('gitBlobSha matches git hash-object', () => {
  const content = 'export default function decorate(block) {}\n';
  let expected;
  try {
    expected = execFileSync('git', ['hash-object', '--stdin'], { input: content }).toString().trim();
  } catch {
    expected = 'skip';
  }
  if (expected !== 'skip') assert.equal(gitBlobSha(content), expected);
});

test('redact removes known secrets and token-shaped strings', () => {
  const s = new Set(['my-installation-token-123']);
  const out = redact({ a: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz', b: 'ghp_abcdefghijklmnopqrstuvwxyz0123', c: 'my-installation-token-123', d: 'Bearer abcdefghijklmnopqrstuvwxyz.1234' }, s);
  assert.ok(!/github_pat_|ghp_|my-installation|abcdefghijklmnopqrstuvwxyz\.1234/.test(out), out);
  const lines = [];
  const log = createLogger({ info: (l) => lines.push(l) }, s);
  log.info('token is', 'my-installation-token-123', new Error('Bearer abcdefghijklmnopqrstuvwxyz0123'));
  assert.ok(!lines[0].includes('my-installation-token-123'));
  assert.ok(!lines[0].includes('abcdefghijklmnopqrstuvwxyz0123'));
});

test('origin allow list', () => {
  const ctx = { org: 'acme', site: 'site' };
  assert.ok(isAllowedOrigin('https://main--site--acme.aem.page', ctx));
  assert.ok(isAllowedOrigin('https://feature-x--site--acme.aem.live', ctx));
  assert.ok(isAllowedOrigin('https://feature-x--site--acme.preview.da.live', ctx));
  assert.ok(!isAllowedOrigin('https://feature-x--other--acme.preview.da.live', ctx));
  assert.ok(!isAllowedOrigin('https://main--site--acme.preview.da.live.evil.com', ctx));
  assert.ok(isAllowedOrigin('http://localhost:3000', ctx));
  assert.ok(isAllowedOrigin('https://da.live', ctx));
  assert.ok(!isAllowedOrigin('https://main--other--acme.aem.page', ctx));
  assert.ok(!isAllowedOrigin('https://evil.example', ctx));
  assert.ok(!isAllowedOrigin('http://main--site--acme.aem.page', ctx));
  const previous = process.env.__OW_NAMESPACE;
  process.env.__OW_NAMESPACE = '28538-blocksource';
  try {
    assert.ok(isAllowedOrigin('https://28538-blocksource.adobeio-static.net', ctx), 'the app serves the plugin itself');
    assert.ok(!isAllowedOrigin('https://other-ns.adobeio-static.net', ctx));
  } finally {
    if (previous === undefined) delete process.env.__OW_NAMESPACE;
    else process.env.__OW_NAMESPACE = previous;
  }
  assert.ok(!isAllowedOrigin('https://main--site--acme.aem.page.evil.example', ctx));
});

function ghWith(handler) {
  return createGitHub({
    owner: 'acme', repo: 'site', getToken: async () => 'tok', fetch: async (url, init) => handler(new URL(url), init),
  });
}

test('GitHub client refuses calls outside the allow list', async () => {
  let called = false;
  const gh = ghWith(() => {
    called = true;
    return jsonRes(200, {});
  });
  await assert.rejects(gh.request('/repos/acme/other'), { code: 'not-allowed' });
  await assert.rejects(gh.request('/repos/acme/site/git/refs'), { code: 'not-allowed' });
  await assert.rejects(gh.request('/repos/acme/site/contents/../../x'), { code: 'not-allowed' });
  await assert.rejects(gh.request('/user'), { code: 'not-allowed' });
  assert.equal(called, false);
  assert.throws(() => createGitHub({ owner: 'a/b', repo: 'c', getToken: async () => '' }), { code: 'bad-config' });
});

test('validation maps GitHub failures to the documented messages', async () => {
  const cases = [
    [() => jsonRes(401, { message: 'Bad credentials' }), 'unauthorized', /not valid, or it has expired/],
    [() => jsonRes(403, { message: 'Resource protected by organization SAML enforcement' }, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=abc' }), 'sso', /Authorise the token/],
    [() => jsonRes(404, { message: 'Not Found' }), 'no-repo-access', /no access to this repository/],
    [() => jsonRes(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }), 'rate-limited', /Too many requests/],
  ];
  for (const [handler, code, msg] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const v = await validateCredential(ghWith(handler));
    assert.equal(v.ok, false);
    assert.equal(v.error.code, code);
    assert.match(v.error.message, msg);
  }
  const sso = await validateCredential(ghWith(cases[1][0]));
  assert.equal(sso.error.ssoUrl, 'https://github.com/orgs/acme/sso?authorization_request=abc');
  const rl = await validateCredential(ghWith(cases[3][0]));
  assert.equal(rl.error.resetAt, new Date(1800000000 * 1000).toISOString());
});

test('validation reports permissions, expiry and missing optional scopes', async () => {
  const now = Date.parse('2026-11-12T00:00:00Z');
  const gh = ghWith((url) => {
    if (url.pathname === '/repos/acme/site') return jsonRes(200, { private: true, default_branch: 'main' }, { 'github-authentication-token-expiration': '2026-11-20 10:00:00 +0100' });
    if (url.pathname === '/rate_limit') return jsonRes(200, { resources: { core: { limit: 5000, remaining: 12, reset: 1800000000 } } });
    if (url.pathname === '/repos/acme/site/commits') return jsonRes(200, [{ sha: 'a'.repeat(40) }]);
    if (url.pathname === '/repos/acme/site/pulls') return jsonRes(403, { message: 'Resource not accessible by personal access token' });
    return jsonRes(200, {});
  });
  const v = await validateCredential(gh, { now });
  assert.equal(v.ok, true);
  assert.equal(v.status.expiresAt, '2026-11-20T09:00:00.000Z');
  assert.equal(v.status.expiresSoon, true);
  assert.equal(v.status.defaultBranch, 'main');
  assert.deepEqual(v.status.missingRequired, []);
  assert.deepEqual(v.status.missingOptional, ['pull_requests']);
  assert.equal(v.status.rateLimit.remaining, 12);
});

test('validation fails when contents permission is missing', async () => {
  const gh = ghWith((url) => {
    if (url.pathname === '/repos/acme/site') return jsonRes(200, { private: true, default_branch: 'main' });
    if (url.pathname === '/rate_limit') return jsonRes(200, { rate: { limit: 5000, remaining: 5000 } });
    return jsonRes(403, { message: 'Resource not accessible' });
  });
  const v = await validateCredential(gh);
  assert.equal(v.ok, false);
  assert.equal(v.error.code, 'forbidden');
  assert.deepEqual(v.status.missingRequired, ['contents']);
});

const model = (fields) => ({ source: 'x', fields: flattenFields(fields) });

test('gate 1: content model diff', () => {
  const base = model([
    { component: 'text', name: 'title', label: 'Title' },
    { component: 'reference', name: 'image', label: 'Image' },
    { component: 'text', name: 'cta', label: 'Call to action' },
    { component: 'text', name: 'note', label: 'Note' },
  ]);
  const head = model([
    { component: 'text', name: 'heading', label: 'Title' },
    { component: 'richtext', name: 'image', label: 'Image' },
    { component: 'text', name: 'cta', label: 'Call to action', required: true },
    { component: 'text', name: 'badge', label: 'Badge' },
    { component: 'text', name: 'alt', label: 'Alt', validation: { required: true } },
  ]);
  const d = diffModels(base, head);
  const kinds = Object.fromEntries(d.changes.map((c) => [c.kind, c]));
  assert.equal(d.verdict, 'unsafe');
  assert.equal(kinds.renamed.field, 'title');
  assert.equal(kinds.removed.field, 'note');
  assert.equal(kinds['type-changed'].field, 'image');
  assert.equal(kinds['now-required'].field, 'cta');
  assert.equal(kinds['added-required'].field, 'alt');
  assert.equal(kinds['added-optional'].unsafe, false);
  assert.match(kinds.renamed.message, /renamed the field “Title”/);

  assert.equal(diffModels(base, model([...base.fields.map((f) => ({ component: f.type, name: f.name, label: f.label })), { component: 'text', name: 'x', label: 'X' }])).verdict, 'safe');
  assert.equal(diffModels(null, null).verdict, 'none');
  assert.equal(diffModels(base, null).verdict, 'unsafe');
  assert.equal(diffModels(null, model([{ component: 'text', name: 'a', label: 'A' }])).verdict, 'safe');
});

test('gate 1: content contract semver', () => {
  assert.equal(compareContracts({ contentContract: '1.2.0' }, { contentContract: '2.0.0' }).verdict, 'unsafe');
  assert.equal(compareContracts({ contentContract: '1.2.0' }, { contentContract: '1.3.1' }).verdict, 'safe');
  assert.equal(compareContracts(null, { contentContract: '2.0.0' }).verdict, 'none');
  assert.equal(compareContracts({ contentContract: 'x' }, { contentContract: '2.0.0' }).verdict, 'none');
});

test('gate 2: file classification', () => {
  const c = classifyChanges([
    { filename: 'blocks/cards/cards.css', status: 'modified' },
    { filename: 'blocks/cards/README.md', status: 'modified' },
  ], 'cards');
  assert.equal(c.cssDocsOnly, true);
  const j = classifyChanges([
    { filename: 'blocks/cards/cards.js', status: 'modified' },
    { filename: 'blocks/cards/_cards.json', status: 'modified' },
    { filename: 'blocks/cards/block.json', status: 'added' },
    { filename: 'blocks/cards/icon.svg', status: 'added' },
  ], 'cards');
  assert.deepEqual([j.js.length, j.model.length, j.manifest.length, j.other.length], [1, 1, 1, 1]);
  assert.equal(j.cssDocsOnly, false);
  assert.equal(classifyChanges([{ filename: 'blocks/cards/x.js', status: 'added' }], 'cards').onlyAdded, true);
});

test('gate 2: DOM signature and hints', () => {
  const base = domSignature(`
    // block.children[9] in a comment is ignored
    export default function decorate(block) {
      [...block.children].forEach((row) => {
        const [image, text] = [...row.children];
      });
    }`);
  assert.equal(base.maxCellIndex, 1);
  const head = domSignature(`
    export default function decorate(block) {
      const intro = block.children[1];
      [...block.children].forEach((row) => {
        const [image, text, cta] = [...row.children];
        row.querySelector('picture img');
        row.querySelector('a.button');
      });
      if (block.classList.contains('featured')) block.querySelector(':scope > div:nth-child(4)');
    }`);
  assert.equal(head.maxRowIndex, 1);
  assert.equal(head.maxCellIndex, 3);
  assert.equal(head.usesImages, true);
  assert.equal(head.usesLinks, true);
  assert.deepEqual(head.variants, ['featured']);
  const hints = signatureHints(base, head);
  const codes = hints.map((h) => h.code);
  assert.ok(codes.includes('more-cells'));
  assert.ok(codes.includes('more-rows'));
  assert.ok(codes.includes('new-variant'));
  assert.deepEqual(hints.find((h) => h.code === 'more-cells'), { code: 'more-cells', from: 2, to: 4 });
});

test('README and header comment parsing', () => {
  const r = parseReadme(`---
title: x
---
# Cards

Shows a **grid** of [linked](https://x) cards.
Second line.

| Image | Text |
| --- | --- |
| A picture | \`Heading\` and body |

## Variants

- \`featured\`
- compact: smaller cards

Sample: https://main--site--acme.aem.page/drafts/cards
`);
  assert.equal(r.description, 'Shows a grid of linked cards. Second line.');
  assert.deepEqual(r.table.headers, ['Image', 'Text']);
  assert.deepEqual(r.table.rows, [['A picture', 'Heading and body']]);
  assert.deepEqual(r.variants, ['featured', 'compact']);
  assert.equal(r.sample, 'https://main--site--acme.aem.page/drafts/cards');

  const h = parseHeaderComment(`import { x } from '../../scripts/aem.js';
/**
 * Hero banner with a background image.
 * @content Row 1: image. Row 2: heading and text.
 * @variants dark, wide
 * @sample /drafts/hero
 */
export default function decorate() {}`);
  assert.equal(h.description, 'Hero banner with a background image.');
  assert.equal(h.content, 'Row 1: image. Row 2: heading and text.');
  assert.deepEqual(h.variants, ['dark', 'wide']);
  assert.equal(h.sample, '/drafts/hero');
  assert.deepEqual(parseHeaderComment('export default 1;'), {});
});

test('preview hostnames', () => {
  assert.deepEqual(previewability('feature-cards', 'site', 'acme'), { previewable: true, reason: null, origin: 'https://feature-cards--site--acme.aem.page' });
  assert.equal(previewability('feature/cards', 'site', 'acme').previewable, false);
  assert.match(previewability('feature/cards', 'site', 'acme').reason, /"\/"/);
  assert.equal(previewability('a_b', 'site', 'acme').previewable, false);
  const long = previewability('x'.repeat(60), 'site', 'acme');
  assert.equal(long.previewable, false);
  assert.match(long.reason, /limit is 63/);
});

test('touchesBlock and protected branches', () => {
  assert.ok(touchesBlock({ filename: 'blocks/cards/cards.js' }, 'cards'));
  assert.ok(!touchesBlock({ filename: 'blocks/cards-v2/cards-v2.js' }, 'cards'));
  assert.ok(touchesBlock({ filename: 'models/_cards.json' }, 'cards'));
  assert.ok(touchesBlock({ filename: 'component-models.json', mentions: ['cards'] }, 'cards'));
  assert.ok(!touchesBlock({ filename: 'component-models.json', mentions: ['hero'] }, 'cards'));
  assert.ok(isProtected('release-2026', ['release-*']));
  assert.ok(!isProtected('feature-release', ['release-*']));
});

test('blockNamesInHtml', () => {
  const html = `<body><header></header><main>
    <div><div class="cards featured"><div><div>x</div></div></div><div class="metadata"></div></div>
    <div><p>text</p><div class="hero"><div><div class="inner">y</div></div></div><div class="section-metadata"></div></div>
  </main><footer><div><div class="footer"></div></div></footer></body>`;
  assert.deepEqual([...blockNamesInHtml(html)].sort(), ['cards', 'hero']);
});

test('rewriteImports makes module specifiers absolute', () => {
  const url = 'https://feature--site--acme.aem.page/blocks/cards/cards.js';
  const out = rewriteImports(`import { a } from '../../scripts/aem.js';
import './side.js';
import x from "https://cdn.example/x.js";
const m = await import('../util/u.js');
const base = new URL('.', import.meta.url);`, url);
  assert.match(out, /from 'https:\/\/feature--site--acme\.aem\.page\/scripts\/aem\.js'/);
  assert.match(out, /import 'https:\/\/feature--site--acme\.aem\.page\/blocks\/cards\/side\.js'/);
  assert.match(out, /"https:\/\/cdn\.example\/x\.js"/);
  assert.match(out, /import\('https:\/\/feature--site--acme\.aem\.page\/blocks\/util\/u\.js'\)/);
  assert.ok(out.includes(`new URL('.', "${url}")`));
});

test('site config parsing', () => {
  const c = parseSiteConfig({
    ':type': 'multi-sheet',
    ':names': ['data', 'blocksource'],
    data: { data: [{ key: 'blocksource.protected', value: 'release-*, hotfix' }, { key: 'blocksource.external', value: 'embed=https://x.example/embed, video=@acme/video' }] },
    blocksource: { data: [{ org: 'acme', repo: 'site' }] },
  });
  assert.equal(c.owner, 'acme');
  assert.equal(c.repo, 'site');
  assert.deepEqual(c.protectedBranches, ['release-*', 'hotfix']);
  assert.deepEqual(c.external, { embed: 'https://x.example/embed', video: '@acme/video' });
  assert.deepEqual(parseSiteConfig(null).protectedBranches, []);
  assert.ok(parseDaActions('/acme/site=read,write').has('write'));
  assert.ok(!parseDaActions('/acme/site=read').has('write'));
});

test('cache serves stale data only on upstream failures', async () => {
  let t = 0;
  const cache = createCache(memoryState(() => t), { now: () => t });
  await cache.wrap('k', 60, async () => 1);
  t = 120000;
  const up = Object.assign(new Error('down'), { upstream: true, code: 'unavailable' });
  const r = await cache.wrap('k', 60, async () => { throw up; });
  assert.equal(r.stale, true);
  assert.equal(r.value, 1);
  await assert.rejects(cache.wrap('k', 60, async () => { throw new Error('bug'); }));
});

test('rate limit per caller per minute', async () => {
  const state = memoryState(() => 0);
  await rateLimit(state, 'c', 2, 0);
  await rateLimit(state, 'c', 2, 1000);
  await assert.rejects(rateLimit(state, 'c', 2, 2000), { status: 429 });
  await rateLimit(state, 'c', 2, 61000);
});

test('CODEOWNERS: the last matching rule wins', () => {
  const text = '# comment\n* @acme/web\n/blocks/ @acme/blocks\nblocks/cards/ @sunny # inline\n*.css @design\n/blocks/hero/** @hero-team\n';
  assert.deepEqual(codeOwnersFor(text, 'blocks/cards/cards.js'), ['@sunny']);
  assert.deepEqual(codeOwnersFor(text, 'blocks/cards/cards.css'), ['@design']);
  assert.deepEqual(codeOwnersFor(text, 'blocks/hero/hero.js'), ['@hero-team']);
  assert.deepEqual(codeOwnersFor(text, 'blocks/tabs/tabs.js'), ['@acme/blocks']);
  assert.deepEqual(codeOwnersFor(text, 'scripts/scripts.js'), ['@acme/web']);
  assert.equal(codeOwnersFor('', 'blocks/cards/cards.js'), null);
});

test('usage scan records the options used with each block', () => {
  const html = '<body><main><div><div class="cards wide dark"></div><div class="cards"></div><div class="section-metadata"></div><p>x</p></div></main></body>';
  const found = blocksInHtml(html);
  assert.deepEqual([...found.keys()], ['cards']);
  assert.deepEqual([...found.get('cards')], ['wide', 'dark']);
});

test('issue search cannot leave the site repository', async () => {
  const urls = [];
  const gh = createGitHub({
    owner: 'acme', repo: 'site', getToken: async () => 't', fetch: async (u) => { urls.push(u); return jsonRes(200, { items: [] }); },
  });
  await gh.searchIssues('is:issue "cards"');
  assert.equal(new URL(urls[0]).searchParams.get('q'), 'repo:acme/site is:issue "cards"');
  await assert.rejects(gh.searchIssues('repo:evil/other is:issue'), /stay in this repository/);
  await assert.rejects(gh.request('/search/issues', { query: { q: 'repo:evil/other x' } }), /stay in this repository/);
});

test('usage scan counts published pages only, not library, template or draft documents', async () => {
  const listing = {
    '': [{ name: 'index', ext: 'html', path: '/acme/site/index.html' }, { name: 'blog', path: '/acme/site/blog' },
      { name: 'blocks', path: '/acme/site/blocks' }, { name: 'drafts', path: '/acme/site/drafts' }, { name: 'templates', path: '/acme/site/templates' }],
    '/blog': [{ name: 'post', ext: 'html', path: '/acme/site/blog/post.html' }],
  };
  const page = '<body><main><div><div class="cards wide"></div></div></main></body>';
  const written = {};
  const deps = {
    now: () => 0,
    log: { info: () => {} },
    config: { daAdminUrl: 'https://admin.da.live' },
    files: { writeJson: async (k, v) => { written[k] = v; } },
    fetch: async (u) => {
      const { pathname } = new URL(u);
      if (pathname.startsWith('/list/acme/site')) {
        const folder = pathname.slice('/list/acme/site'.length);
        if (!(folder in listing)) throw new Error(`listed ${folder}`);
        return jsonRes(200, listing[folder]);
      }
      return new Response(page, { status: 200 });
    },
  };
  const r = await scanUsage(deps, { org: 'acme', site: 'site', token: 't' });
  assert.equal(r.pages, 2);
  assert.deepEqual(r.blocks.cards, { count: 2, pages: ['/', '/blog/post'], variants: { wide: 2 } });
});

test('the GitHub client allows exactly one write: opening an issue in its repository', async () => {
  const calls = [];
  const gh = createGitHub({
    owner: 'acme', repo: 'site', getToken: async () => 'x', fetch: async (url, init) => { calls.push([init.method, url]); return new Response('{}', { status: 201 }); },
  });
  await gh.createIssue({ title: 't', body: 'b' });
  assert.deepEqual(calls, [['POST', 'https://api.github.com/repos/acme/site/issues']]);
  for (const path of ['/repos/acme/site/pulls', '/repos/acme/other/issues', '/repos/acme/site/issues/1/comments', '/repos/acme/site/contents/a']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(gh.request(path, { method: 'POST', body: {} }), /allow list/);
  }
  await assert.rejects(gh.request('/repos/acme/site/issues', { method: 'PATCH', body: {} }), /allow list/);
  assert.equal(calls.length, 1);
});
