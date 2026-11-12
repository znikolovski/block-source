'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handle } = require('../lib/router');
const { buildIndex } = require('../lib/branches');
const { createCache } = require('../lib/cache');
const { githubFor, loadRecord } = require('../lib/token-store');
const {
  ADMIN, AUTHOR, STRANGER, PAT, makeDeps, request, parse, jsonRes, sha,
} = require('./helpers');

async function configured(opts) {
  const ctx = await makeDeps(opts);
  const res = parse(await handle(request('POST', '/admin/token', { token: ADMIN, body: { token: PAT } }), ctx.deps));
  assert.equal(res.statusCode, 200, res.body);
  return ctx;
}

const call = async (ctx, method, path, opts) => parse(await handle(request(method, path, opts), ctx.deps));

test('the PAT never leaves the broker: responses, logs, storage', async () => {
  const ctx = await configured();
  const all = [await call(ctx, 'GET', '/admin/token', { token: ADMIN })];
  ctx.deps.fetch = ((orig) => async (url, init) => {
    if (/api\.github\.com\/repos\/acme\/site\/pulls/.test(url)) return jsonRes(500, { message: `echo ${init.headers.Authorization}` });
    return orig(url, init);
  })(ctx.deps.fetch);
  all.push(await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'cards', ref: 'main' } }));
  all.push(await call(ctx, 'POST', '/admin/token/validate', { token: ADMIN }));
  all.push(await call(ctx, 'POST', '/admin/token', { token: ADMIN, body: { token: 'github_pat_bad_0000000000000000000000000000' } }));
  const everything = JSON.stringify(all) + ctx.lines.join('\n') + JSON.stringify([...ctx.files.map.values()]) + JSON.stringify([...ctx.state.map.values()]);
  assert.ok(!everything.includes(PAT), 'PAT leaked');
  assert.ok(!everything.includes(PAT.slice(11, 40)), 'PAT fragment leaked');
  const status = all[0].json;
  assert.equal(status.configured, true);
  assert.equal(status.last4, PAT.slice(-4));
  assert.equal(status.type, 'fine-grained');
  assert.equal(status.expiresAt, '2026-11-20T10:00:00.000Z');
  assert.equal(status.live.ok, true);
  assert.equal(status.audit[0].action, 'set');
  assert.equal(status.audit[0].actor.email, 'admin@example.com');
  assert.equal(status.owner, 'acme');
  assert.deepEqual(status.settings.protectedBranches, ['release-*']);
});

test('only administrators can manage the token; non-members are rejected', async () => {
  const ctx = await makeDeps();
  const author = await call(ctx, 'POST', '/admin/token', { token: AUTHOR, body: { token: PAT } });
  assert.equal(author.statusCode, 403);
  assert.equal(author.json.error, 'not-admin');
  assert.equal(await loadRecord(ctx.files, 'acme', 'site'), null);
  const stranger = await call(ctx, 'GET', '/status', { token: STRANGER });
  assert.equal(stranger.statusCode, 403);
  assert.equal(stranger.json.error, 'no-access');
  const anon = await call(ctx, 'GET', '/status', {});
  assert.equal(anon.statusCode, 401);
  const status = await call(ctx, 'GET', '/status', { token: AUTHOR });
  assert.deepEqual([status.json.configured, status.json.isAdmin], [false, false]);
  const notConfigured = await call(ctx, 'GET', '/history', { token: AUTHOR, query: { block: 'cards' } });
  assert.equal(notConfigured.statusCode, 409);
});

test('an invalid token is rejected and the old one is kept', async () => {
  const ctx = await configured();
  const before = await loadRecord(ctx.files, 'acme', 'site');
  const bad = await call(ctx, 'POST', '/admin/token', { token: ADMIN, body: { token: 'ghp_wrongwrongwrongwrongwrongwrong1234' } });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json.error, 'unauthorized');
  assert.deepEqual(await loadRecord(ctx.files, 'acme', 'site'), before);
  const del = await call(ctx, 'DELETE', '/admin/token', { token: ADMIN });
  assert.equal(del.statusCode, 200);
  assert.equal(await loadRecord(ctx.files, 'acme', 'site'), null);
  const audit = JSON.parse(ctx.files.map.get('audit/acme/site.json'));
  assert.deepEqual(audit.map((a) => a.action), ['remove', 'set']);
});

test('a token for the wrong repository is rejected', async () => {
  const ok = await configured();
  const status = await call(ok, 'GET', '/admin/token', { token: ADMIN });
  assert.equal(status.json.siteCheck.state, 'match');
  assert.equal(status.json.siteCheck.origin, 'https://main--site--acme.aem.live');

  const mismatch = await call(ok, 'POST', '/admin/token', { token: ADMIN, body: { token: PAT, owner: 'acme', repo: 'other' } });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json.error, 'repo-mismatch');
  assert.match(mismatch.json.message, /acme\/site, not acme\/other/);

  const noConfig = [/admin\.da\.live\/config\/acme\/site\//, () => jsonRes(200, { data: [] }, { 'x-da-actions': '/acme/site=read,write' })];
  const blind = await makeDeps({ overrides: [noConfig] });
  const noAccess = await call(blind, 'POST', '/admin/token', { token: ADMIN, body: { token: PAT, owner: 'acme', repo: 'private-other' } });
  assert.equal(noAccess.statusCode, 422);
  assert.equal(noAccess.json.error, 'no-repo-access');
  assert.match(noAccess.json.message, /cannot see acme\/private-other/);

  const otherCode = [/aem\.live\/(scripts|styles)\//, () => new Response('different site code', { status: 200 })];
  const wrong = await makeDeps({ overrides: [otherCode] });
  const wrongRepo = await call(wrong, 'POST', '/admin/token', { token: ADMIN, body: { token: PAT } });
  assert.equal(wrongRepo.statusCode, 422);
  assert.equal(wrongRepo.json.error, 'wrong-repo');
  assert.match(wrongRepo.json.message, /main--site--acme\.aem\.live is different/);
  assert.equal(await loadRecord(wrong.files, 'acme', 'site'), null);

  const unpublished = await makeDeps({ overrides: [[/aem\.live\//, () => new Response('', { status: 404 })]] });
  const saved = await call(unpublished, 'POST', '/admin/token', { token: ADMIN, body: { token: PAT } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json.siteCheck.state, 'unverified');
});

test('request guards: origin, unknown routes, input validation, CORS preflight, rate limit', async () => {
  const ctx = await configured({ config: { rateLimit: 5 } });
  const evil = await call(ctx, 'GET', '/status', { token: AUTHOR, origin: 'https://evil.example' });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal((await call(ctx, 'GET', '/proxy', { token: AUTHOR })).statusCode, 404);
  assert.equal((await call(ctx, 'GET', '/history', { token: AUTHOR, query: { block: '../x' } })).statusCode, 400);
  assert.equal((await call(ctx, 'GET', '/history', { token: AUTHOR, query: { block: 'cards', ref: 'a..b' } })).statusCode, 400);
  const pre = await handle(request('OPTIONS', '/status'), ctx.deps);
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['Access-Control-Allow-Origin'], 'https://main--site--acme.aem.page');
  let last;
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await call(ctx, 'GET', '/status', { token: AUTHOR });
  }
  assert.equal(last.statusCode, 429);
  assert.ok(last.headers['Retry-After']);
});

test('feature 1: history marks the commit in use, deployed check compares blob SHAs', async () => {
  const ctx = await configured();
  const h = await call(ctx, 'GET', '/history', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(h.statusCode, 200, h.body);
  assert.equal(h.json.resolved.kind, 'code');
  assert.equal(h.json.commits.length, 2);
  assert.equal(h.json.commits[0].inUse, true);
  assert.equal(h.json.commits[1].inUse, false);
  assert.equal(h.json.commits[0].author.noreply, true);
  assert.deepEqual(h.json.commits[0].files.js.map((f) => f.path), ['blocks/cards/cards.js']);
  assert.equal(h.json.relation.isDefault, true);

  const d = await call(ctx, 'GET', '/deployed', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(d.json.state, 'in-use');

  const missing = await call(ctx, 'GET', '/history', { token: AUTHOR, query: { block: 'nope', ref: 'main' } });
  assert.equal(missing.json.resolved.kind, 'not-code-block');
  const badRef = await call(ctx, 'GET', '/history', { token: AUTHOR, query: { block: 'cards', ref: 'gone' } });
  assert.equal(badRef.statusCode, 404);
});

test('feature 2: newer versions filter by block, activity, protection and previewability', async () => {
  const ctx = await configured();
  const r = await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(r.statusCode, 200, r.body);
  const names = r.json.branches.map((b) => b.name).sort();
  assert.deepEqual(names, ['css-only', 'feature-cards', 'feature/slash', 'model-change']);
  const fc = r.json.branches.find((b) => b.name === 'feature-cards');
  assert.equal(fc.previewable, true);
  assert.equal(fc.pr.number, 7);
  assert.equal(fc.blockAheadBy, 1);
  assert.equal(fc.newest.subject, 'Add CTA column');
  assert.match(fc.compareUrl, /compare\/main\.\.\.feature-cards$/);
  const slash = r.json.branches.find((b) => b.name === 'feature/slash');
  assert.equal(slash.previewable, false);
  assert.equal(r.json.pullsAvailable, true);
  assert.equal(r.json.fromIndex, false);

  // Comparisons are cached by SHA pair: a second block on the same page costs no compare calls.
  const before = ctx.fetchLog.filter((l) => l.url.includes('/compare/')).length;
  await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'hero', ref: 'main' } });
  assert.equal(ctx.fetchLog.filter((l) => l.url.includes('/compare/')).length, before);

  // The branch list is cached; "Check again" (fresh=1) lists the branches again.
  const lists = () => ctx.fetchLog.filter((l) => /\/branches(\?|$)/.test(l.url)).length;
  const listed = lists();
  await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(lists(), listed);
  await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'cards', ref: 'main', fresh: '1' } });
  assert.ok(lists() > listed);
});

test('feature 2: the warm index narrows the scan', async () => {
  const ctx = await configured();
  const record = await loadRecord(ctx.files, 'acme', 'site');
  const index = await buildIndex(githubFor(record, ctx.deps), ctx.deps, { org: 'acme', site: 'site', record });
  assert.deepEqual(index.blocks.hero, ['other-block']);
  assert.ok(!index.blocks.cards.includes('old-branch'));
  const r = await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'hero', ref: 'main' } });
  assert.equal(r.json.fromIndex, true);
  assert.equal(r.json.scanned, 1);
  assert.equal(r.json.truncated, false, 'branches the index ruled out are not "unchecked"');
  assert.deepEqual(r.json.branches.map((b) => b.name), ['other-block']);
});

test('feature 3: summary from README with generated fallbacks marked', async () => {
  const ctx = await configured();
  ctx.files.map.set('usage/acme/site.json', JSON.stringify({
    scannedAt: '2026-11-11T03:00:00Z', complete: true, blocks: { cards: { count: 3, pages: ['/a', '/b', '/c'] } },
  }));
  const s = await call(ctx, 'GET', '/summary', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json.description, 'Shows a grid of linked cards.');
  assert.equal(s.json.descriptionSource, 'readme');
  assert.deepEqual(s.json.contentShape.headers, ['Column 1', 'Column 2']);
  assert.deepEqual(s.json.variants, ['featured']);
  assert.equal(s.json.usedOn.count, 3);
  assert.equal(s.json.lastChanged.author.name, 'Sunny Wan');
  assert.deepEqual(s.json.generated, []);
});

test('insights: usage, options, last change, issues, work in progress, owners, docs', async () => {
  const ctx = await configured();
  ctx.files.map.set('usage/acme/site.json', JSON.stringify({
    scannedAt: '2026-11-11T03:00:00Z',
    complete: true,
    pages: 40,
    blocks: { cards: { count: 3, pages: ['/a', '/b', '/c'], variants: { default: 2, wide: 1 } } },
  }));
  const r = await call(ctx, 'GET', '/insights', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(r.statusCode, 200, r.body);
  const i = r.json;
  assert.equal(i.usedOn.count, 3);
  assert.equal(i.usedOn.total, 40);
  assert.deepEqual(i.variants, [{ name: 'default', pages: 2 }, { name: 'wide', pages: 1 }, { name: 'featured', pages: 0 }], 'documented but unused options are listed');
  assert.equal(i.lastChanged.author.name, 'Sunny Wan');
  // Labelled and mentioned issues are merged, pull requests are dropped.
  assert.equal(i.issues.state, 'ok');
  assert.deepEqual(i.issues.items.map((x) => [x.number, x.match]), [[5, 'mention'], [3, 'label']]);
  assert.equal(i.issues.labelled, 1);
  const search = ctx.fetchLog.find((l) => l.url.includes('/search/issues'));
  assert.match(new URL(search.url).searchParams.get('q'), /^repo:acme\/site is:issue is:open "cards"/);
  assert.deepEqual(i.work.branches.map((b) => b.name).sort(), ['css-only', 'feature-cards', 'feature/slash', 'model-change']);
  assert.equal(i.work.pulls, 1);
  assert.equal(i.owners.source, 'codeowners');
  assert.deepEqual(i.owners.people.map((p) => p.handle), ['@sunnywan', '@acme/design']);
  assert.deepEqual(i.docs, {
    readme: true, contentModel: true, description: 'written', sample: false,
  });

  // A token without the Issues permission still gets the rest of the report.
  const noIssues = await configured({ overrides: [[/\/issues(\?|$)/, () => jsonRes(403, { message: 'Resource not accessible by personal access token' })]] });
  const r2 = await call(noIssues, 'GET', '/insights', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json.issues.state, 'no-permission');
  assert.equal(r2.json.usedOn, null);
  assert.ok(r2.json.lastChanged);
});

test('feature 4: compatibility verdicts per gate', async () => {
  const ctx = await configured();
  const compat = (branch) => call(ctx, 'GET', '/compat', { token: AUTHOR, query: { block: 'cards', ref: 'main', branch } });

  const css = await compat('css-only');
  assert.equal(css.json.verdict, 'safe');
  assert.equal(css.json.decidedBy, 'gate2');
  assert.match(css.json.reasons[0].message, /only changes styles/);

  const js = await compat('feature-cards');
  assert.equal(js.json.verdict, 'needs-dry-run');
  assert.ok(js.json.hints.some((h) => h.code === 'more-cells' && h.from === 2 && h.to === 3));
  assert.ok(js.json.hints.some((h) => h.code === 'new-selector' && h.selector === 'a.button'));
  assert.equal(js.json.contact.pr.number, 7);
  assert.equal(js.json.contact.author.login, 'sunnywan');

  const model = await compat('model-change');
  assert.equal(model.json.verdict, 'blocked');
  assert.equal(model.json.decidedBy, 'gate1');
  assert.equal(model.json.reasons[0].code, 'removed');
  assert.match(model.json.reasons[0].message, /“Image”/);

  const none = await compat('other-block');
  assert.equal(none.json.verdict, 'safe');
  assert.equal(none.json.reasons[0].code, 'no-change');

  assert.equal((await compat('missing')).statusCode, 404);
});

test('feature 4: module fallback rewrites imports to the branch origin', async () => {
  const ctx = await configured();
  const m = await call(ctx, 'GET', '/module', { token: AUTHOR, query: { block: 'cards', branch: 'feature-cards' } });
  assert.equal(m.statusCode, 200, m.body);
  assert.equal(m.json.moduleUrl, 'https://feature-cards--site--acme.aem.page/blocks/cards/cards.js');
  assert.equal(m.json.sha, sha('b'));
  const bad = await call(ctx, 'GET', '/module', { token: AUTHOR, query: { block: 'cards', branch: 'feature/slash' } });
  assert.equal(bad.statusCode, 400);
});

test('stale cache is served when GitHub is down', async () => {
  let down = false;
  const ctx = await configured();
  ctx.deps.fetch = ((orig) => async (url, init) => {
    if (down && /api\.github\.com\/repos\/acme\/site\/branches/.test(url)) return jsonRes(503, {});
    return orig(url, init);
  })(ctx.deps.fetch);
  const ok = await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(ok.json.stale, false);
  down = true;
  ctx.deps.now = () => Date.parse('2026-11-12T00:10:00Z');
  ctx.deps.cache = createCache(ctx.state, { now: ctx.deps.now });
  const stale = await call(ctx, 'GET', '/branches', { token: AUTHOR, query: { block: 'cards', ref: 'main' } });
  assert.equal(stale.statusCode, 200, stale.body);
  assert.equal(stale.json.stale, true);
});

test('telemetry counts events and surfaces often-blocked blocks', async () => {
  const ctx = await configured();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await call(ctx, 'POST', '/telemetry', {
      token: AUTHOR,
      body: {
        event: 'compat-checked', block: 'cards', branch: 'model-change', verdict: 'blocked',
      },
    });
  }
  const bad = await call(ctx, 'POST', '/telemetry', { token: AUTHOR, body: { event: 'nope' } });
  assert.equal(bad.statusCode, 400);
  const admin = await call(ctx, 'GET', '/admin/token', { token: ADMIN });
  assert.ok(JSON.stringify(admin.json.insights).includes('cards'));
});

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;
const report = (body) => ({
  token: AUTHOR,
  body: {
    block: 'cards', branch: 'feature-cards', title: 'Images overlap', details: 'On mobile the **images** overlap the text.', page: '/blog/post', ...body,
  },
});

test('feature 6: an author raises an issue with a screenshot that GitHub can load', async () => {
  const ctx = await configured({ config: { publicUrl: 'https://broker.test/api' } });
  const r = await call(ctx, 'POST', '/issues', report({ screenshot: JPEG }));
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json, {
    number: 42, url: 'https://github.com/acme/site/issues/42', screenshot: true, labelled: true,
  });
  const [issue] = ctx.fx.created;
  assert.equal(issue.title, 'cards: Images overlap');
  assert.deepEqual(issue.labels, ['block:cards']);
  assert.match(issue.body, /^On mobile the \*\*images\*\* overlap the text\./);
  assert.match(issue.body, /\| Branch \| `feature-cards` \|/);
  assert.match(issue.body, new RegExp(`tree/${ctx.fx.B['feature-cards']}/blocks/cards`));
  assert.match(issue.body, /feature-cards--site--acme\.aem\.page\/blog\/post/);
  assert.match(issue.body, /Reported by \| Ada Admin/);
  assert.ok(!issue.body.includes('@example.com'), 'no email address in the issue');
  const shot = issue.body.match(/!\[[^\]]*\]\((https:\/\/broker\.test\/api\/shot\?[^)]+)\)/);
  assert.ok(shot, issue.body);

  // The screenshot is public (no DA token, no origin), immutable, and only by its exact id.
  const q = Object.fromEntries(new URL(shot[1]).searchParams);
  const img = await handle(request('GET', '/shot', { query: q, origin: undefined }), ctx.deps);
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['Content-Type'], 'image/jpeg');
  assert.equal(img.body, JPEG.split(',')[1]);
  const miss = await handle(request('GET', '/shot', { query: { id: `${'0'.repeat(32)}.jpg` }, origin: undefined }), ctx.deps);
  assert.equal(miss.statusCode, 404);
  const sneaky = await handle(request('GET', '/shot', { query: { id: '../tokens/acme/site.json' }, origin: undefined }), ctx.deps);
  assert.equal(sneaky.statusCode, 404);

  // GitHub's issue list lags new issues (the fake never lists #42); Insights still counts it.
  const before = (await call(ctx, 'GET', '/insights', { token: AUTHOR, query: { block: 'cards', ref: 'main' } })).json.issues;
  assert.ok(before.items.some((i) => i.number === 42), JSON.stringify(before.items));
  const fresh = await configured();
  const baseline = (await call(fresh, 'GET', '/insights', { token: AUTHOR, query: { block: 'cards', ref: 'main' } })).json.issues;
  assert.equal(before.open, baseline.open + 1);
  assert.equal(before.labelled, baseline.labelled + 1);
});

test('feature 6: raising issues is checked, limited and explains missing permission', async () => {
  const ctx = await configured();
  assert.equal((await call(ctx, 'POST', '/issues', { ...report(), token: STRANGER })).statusCode, 403);
  const notImage = await call(ctx, 'POST', '/issues', report({ screenshot: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` }));
  assert.equal(notImage.json.error, 'bad-screenshot');
  assert.equal((await call(ctx, 'POST', '/issues', report({ branch: 'no-such-branch' }))).statusCode, 200, 'fake resolves any ref');
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await call(ctx, 'POST', '/issues', report())).statusCode, 200);
  }
  assert.equal((await call(ctx, 'POST', '/issues', report())).json.error, 'too-many-reports');

  const ro = await configured({
    overrides: [[/api\.github\.com\/repos\/acme\/site\/issues$/, (url, init) => (init.method === 'POST'
      ? jsonRes(403, { message: 'Resource not accessible by personal access token' })
      : jsonRes(200, []))]],
  });
  const denied = await call(ro, 'POST', '/issues', report());
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json.error, 'no-issue-permission');
});
