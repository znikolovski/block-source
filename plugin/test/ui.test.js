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
// The plugin's canvas channel must not keep the test process alive.
const NativeChannel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends NativeChannel {
  constructor(name) {
    super(name);
    this.unref();
  }
};

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Stands in for agent.js on the canvas: answers on the BroadcastChannel like the real agent. */
function fakeCanvas() {
  const applied = new Map();
  const channel = new globalThis.BroadcastChannel('block-source:canvas');
  channel.onmessage = ({ data: m }) => {
    if (!m || m.type === 'block-source:agent-reply') return;
    const methods = {
      'block-source:agent-hello': () => ({ hello: true, path: '/drafts/page' }),
      'block-source:agent-apply': () => applied.set(`${m.args.block}:${m.args.instance}`, m.args) && true,
      'block-source:agent-revert': () => applied.delete(m.args.id),
      'block-source:agent-list': () => [...applied].map(([id, a]) => ({
        id, block: a.block, instance: a.instance, branch: a.branch, sha: a.sha,
      })),
      'block-source:agent-capture': () => ({ dataUrl: PNG, fits: true }),
    };
    channel.postMessage({
      type: 'block-source:agent-reply', id: m.id, tab: m.tab, org: m.org, site: m.site, ok: true, result: methods[m.type](),
    });
  };
  return applied;
}

const app = () => document.getElementById('app');
const button = (text) => [...app().querySelectorAll('button')].find((b) => b.textContent.trim() === text);

test('author flow: header, callout, timeline, one-click preview, pages, report with screenshot, about', async () => {
  const ctx = await makeDeps({ config: { publicUrl: BROKER } });
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
  const applied = fakeCanvas();
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

  // History is a timeline: newer versions first, then the commits on the page's branch.
  live({ html: LIVE, selection: { blockIndex: 1 } });
  await until(() => app().querySelector('.bs-tl li.inuse') && /Coming next/.test(app().querySelector('.bs-panel').textContent), 'history timeline');
  assert.match(app().querySelector('.bs-title').textContent, /cards/);
  assert.match(app().querySelector('.bs-tl li.inuse').textContent, /In use on this page/);
  const tabs = () => [...app().querySelectorAll('[role="tab"]')].map((t) => t.querySelector('.bs-tab-label').textContent);
  assert.deepEqual(tabs(), ['History', 'Versions', 'Pages', 'Issues', 'About']);

  // The header and callout carry the four things authors use most.
  await until(() => app().querySelector('.bs-callout.newer') && app().querySelector('#tab-issues .bs-badge'), 'callout and badges');
  assert.ok(app().querySelector('.bs-header .bs-usage'), 'usage pill in the header');
  assert.ok(app().querySelector('.bs-header .bs-report-btn'), 'report button in the header');
  assert.equal(app().querySelector('#tab-versions .bs-badge').textContent, '4');
  assert.equal(app().querySelector('#tab-issues .bs-badge').textContent, '2');
  assert.match(app().querySelector('.bs-callout').textContent, /4 newer versions/);
  assert.equal(app().querySelector('.bs-glance'), null, 'the glance strip is gone');

  // One click: the version that does not fit says so instead of previewing.
  button('See all 4').click();
  await until(() => app().querySelectorAll('.bs-card').length >= 2 && /model-change/.test(app().textContent), 'branches');
  assert.ok(app().querySelector('.bs-callout-slot').hidden, 'no callout on the Versions tab');
  const card = (name) => [...app().querySelectorAll('.bs-card')].find((c) => c.querySelector('.bs-ref').textContent === name);
  assert.ok(!card('old-branch'), 'stale branches are hidden');
  card('model-change').querySelector('button').click();
  await until(() => card('model-change').querySelector('.bs-verdict.blocked'), 'blocked verdict');
  assert.match(card('model-change').textContent, /does not fit your content/);
  assert.equal(applied.size, 0);

  // One click: a version that fits is checked and swapped in on the canvas.
  card('css-only').querySelector('button').click();
  await until(() => card('css-only').classList.contains('pv'), 'preview applied');
  assert.match(card('css-only').textContent, /Previewing on the canvas/);
  assert.equal(applied.get('cards:0').branch, 'css-only');
  assert.match(app().querySelector('.bs-header').textContent, /css-only previewed/);

  // Elsewhere, the callout shows what is previewed, with Revert and Report.
  button('History').click();
  await until(() => app().querySelector('.bs-callout.previewing'), 'previewing callout');
  await until(() => app().querySelector('.bs-next.pv'), 'timeline marks the previewed version');

  // Pages: the count is in the header; the tab lists the pages.
  app().querySelector('.bs-usage').click();
  await until(() => app().querySelector('#tab-pages').getAttribute('aria-selected') === 'true' && !/Loading/.test(app().querySelector('.bs-panel').textContent), 'pages tab');
  assert.match(app().querySelector('.bs-panel').textContent, /counted|pages use this block|page uses this block/i);

  // Report the previewed version: the screenshot comes from the canvas.
  [...app().querySelectorAll('.bs-callout button')].find((b) => /Report a problem/.test(b.textContent)).click();
  const form = await until(() => app().querySelector('form.bs-report'), 'report form');
  assert.equal(app().querySelector('#tab-issues').getAttribute('aria-selected'), 'true');
  assert.match(form.textContent, /on branch css-only \(previewed on the canvas\)/);
  await until(() => form.querySelector('.bs-shot-img'), 'screenshot');
  form.querySelector('[name="title"]').value = 'Images overlap';
  form.querySelector('[name="details"]').value = 'On mobile.';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => /Issue #42 raised in acme\/site\. The screenshot is attached/.test(app().querySelector('.bs-panel').textContent), 'issue raised');
  assert.equal(ctx.fx.created[0].title, 'cards: Images overlap');
  assert.match(ctx.fx.created[0].body, /\| Page \| \[\/drafts\/page\]/);
  assert.match(ctx.fx.created[0].body, /css-only/);
  assert.match(ctx.fx.created[0].body, /\/shot\?/, 'the screenshot is linked');
  await until(() => app().querySelector('#tab-issues .bs-badge')?.textContent === '3', 'issue count goes up');

  // Revert from the callout.
  button('Done').click();
  await until(() => app().querySelector('.bs-report-cta'), 'report call to action');
  await until(() => /#42 · updated/.test(app().querySelector('.bs-panel').textContent), 'new issue listed');
  button('Revert').click();
  await until(() => !applied.size && !app().querySelector('.bs-callout.previewing'), 'reverted');

  // About: what it does and who to ask, without usage or issues.
  button('About').click();
  await until(() => /What it does/.test(app().querySelector('.bs-panel').textContent), 'about');
  assert.match(app().querySelector('.bs-panel').textContent, /Who to ask[\s\S]*@sunnywan/);
  assert.doesNotMatch(app().querySelector('.bs-panel').textContent, /Used on|Open issues|Options/);

  await tick(50);
  assert.ok(calls.includes('POST /telemetry'), calls.join(', '));
  const telemetry = await handle(request('GET', '/admin/token', { token: ADMIN }), ctx.deps);
  assert.equal(JSON.parse(telemetry.body).insights.oftenBlocked[0].block, 'cards');
});
