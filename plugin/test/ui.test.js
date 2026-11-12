import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { installDom } from './dom.js';

const require = createRequire(import.meta.url);
const { handle } = require('../../broker/lib/router.js');
const {
  ADMIN, AUTHOR, PAT, makeDeps, request,
} = require('../../broker/test/helpers.js');

const SDK = 'https://da.live/nx/utils/sdk.js';
const BROKER = 'https://broker.test/api';
registerHooks({
  resolve: (specifier, context, next) => (specifier === SDK
    ? { url: new URL('./fixtures/sdk.js', import.meta.url).href, shortCircuit: true }
    : next(specifier, context)),
});

const LIVE = `<body><main>
  <div><div class="hero"><div><div><h1>Hi</h1></div></div></div></div>
  <div><div class="cards" data-block-index="1"><div><div><p>One</p></div><div><p>Two</p></div></div></div></div>
</main></body>`;

const tick = (ms = 20) => new Promise((r) => { setTimeout(r, ms); });
async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}:\n${document.getElementById('app').textContent}`);
}
const app = () => document.getElementById('app');
const button = (text) => [...app().querySelectorAll('button')].find((b) => b.textContent.trim() === text);

test('author flow: select block, history, versions, gate verdicts, about', async () => {
  const ctx = await makeDeps();
  const set = await handle(request('POST', '/admin/token', { token: ADMIN, body: { token: PAT } }), ctx.deps);
  assert.equal(set.statusCode, 200);

  installDom('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', 'https://main--site--acme.aem.page/tools/block-source/block-source.html');
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (!url.startsWith(BROKER)) return new Response('not found', { status: 404 });
    calls.push(`${init.method} ${u.pathname.slice(4)}`);
    const res = await handle({
      __ow_method: init.method.toLowerCase(),
      __ow_path: u.pathname.slice(4),
      __ow_headers: { origin: window.location.origin, authorization: init.headers.Authorization },
      __ow_query: u.searchParams.toString(),
      __ow_body: init.body,
    }, ctx.deps);
    return new Response(res.body || null, { status: res.statusCode, headers: res.headers });
  };
  let live;
  globalThis.daSdk = {
    context: { org: 'acme', repo: 'site', path: '/drafts/page' },
    token: AUTHOR,
    capabilities: { liveDocument: 1 },
    actions: {
      daFetch: async () => new Response(JSON.stringify({ data: [{ key: 'blocksource.broker', value: BROKER }] })),
      subscribeLiveDocument: (cb) => { live = cb; },
    },
  };

  await import('../tools/block-source/block-source.js');
  await until(() => live, 'live document subscription');
  assert.match(app().textContent, /Select a block/);
  assert.equal(app().querySelector('[aria-label="Settings"]'), null, 'authors get no settings gear');

  live({ html: LIVE, selection: { blockIndex: 1 } });
  await until(() => app().querySelector('.bs-list'), 'history');
  assert.match(app().querySelector('.bs-title').textContent, /cards/);
  assert.ok(app().querySelector('.bs-chip.inuse'), 'in-use commit is marked');

  button('Versions').click();
  await until(() => app().querySelectorAll('.bs-card').length >= 2 && /model-change/.test(app().textContent), 'branches');
  const card = (name) => [...app().querySelectorAll('.bs-card')].find((c) => c.querySelector('.bs-ref').textContent === name);
  assert.ok(card('feature-cards'));
  assert.ok(!card('old-branch'), 'stale branches are hidden');

  card('model-change').querySelector('button').click();
  await until(() => card('model-change').querySelector('.bs-verdict.blocked'), 'blocked verdict');
  assert.match(card('model-change').textContent, /does not fit your content/);

  card('css-only').querySelector('button').click();
  await until(() => card('css-only').querySelector('.bs-verdict:not(.running)'), 'css verdict');
  assert.ok(card('css-only').querySelector('.bs-verdict.safe'), card('css-only').textContent);
  assert.ok(button('Preview on canvas'));

  assert.deepEqual([...app().querySelectorAll('[role="tab"]')].map((t) => t.textContent), ['History', 'Versions', 'Insights', 'About']);
  button('About').click();
  await until(() => /What it does/.test(app().querySelector('.bs-panel').textContent), 'about');
  assert.doesNotMatch(app().querySelector('.bs-panel').textContent, /Used on|Last change|Options/, 'About leaves usage and history to Insights');

  // The at-a-glance strip opens the Insights tab.
  await until(() => app().querySelectorAll('.bs-stat-value').length === 4 && !/…/.test(app().querySelector('.bs-glance').textContent), 'glance');
  const stat = (label) => [...app().querySelectorAll('.bs-stat')].find((b) => b.querySelector('.bs-stat-label').textContent === label);
  assert.equal(stat('open issues').querySelector('.bs-stat-value').textContent, '2');
  assert.equal(stat('in progress').querySelector('.bs-stat-value').textContent, '4');
  stat('open issues').click();
  await until(() => /Who to ask/.test(app().querySelector('.bs-panel').textContent), 'insights tab');
  assert.equal(app().querySelector('#tab-insights').getAttribute('aria-selected'), 'true');
  assert.match(app().querySelector('.bs-panel').textContent, /Open issues2[\s\S]*@sunnywan/);

  // Report a problem: no canvas here, so the issue goes without a screenshot.
  button('Report a problem').click();
  const form = await until(() => app().querySelector('form.bs-report'), 'report form');
  assert.match(form.textContent, /on branch main/);
  form.querySelector('[name="title"]').value = 'Images overlap';
  form.querySelector('[name="details"]').value = 'On mobile.';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => /Issue #42 raised in acme\/site/.test(app().querySelector('.bs-panel').textContent), 'issue raised');
  assert.equal(ctx.fx.created[0].title, 'cards: Images overlap');
  assert.match(ctx.fx.created[0].body, /\| Page \| \[\/drafts\/page\]/);

  await tick(50);
  assert.ok(calls.includes('POST /telemetry'), calls.join(', '));
  const telemetry = await handle(request('GET', '/admin/token', { token: ADMIN }), ctx.deps);
  assert.equal(JSON.parse(telemetry.body).insights.oftenBlocked[0].block, 'cards');
});
