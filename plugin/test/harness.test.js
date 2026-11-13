import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom.js';

installDom('<!DOCTYPE html><html><head></head><body><main><div><div class="cards-wrapper"><div class="cards"><div><div>Old</div></div></div></div></div></main></body></html>');

const { run, allowedParent } = await import('../tools/block-source/dryrun.js');
const agent = await import('../tools/block-source/agent.js');

const mod = (body) => `data:text/javascript,${encodeURIComponent(`export default function decorate(block) { ${body} }`)}`;
const HTML = '<div class="cards"><div><div><p>Hello world</p></div><div><a href="https://x">Link</a></div></div></div>';

test('harness decorates with the branch module and measures before/after', async () => {
  const ok = await run({ block: 'cards', html: HTML, moduleUrl: mod("block.append(Object.assign(document.createElement('p'), { textContent: 'Extra' }));") });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.before.words, ['hello', 'world', 'link']);
  assert.deepEqual(ok.after.words, ['hello', 'world', 'link', 'extra']);
  assert.equal(document.querySelector('main .cards').dataset.blockName, 'cards');

  const lossy = await run({ block: 'cards', html: HTML, moduleUrl: mod("block.querySelectorAll('a').forEach((a) => a.remove());") });
  assert.equal(lossy.ok, true);
  assert.equal(lossy.after.links, 0);

  const thrown = await run({ block: 'cards', html: HTML, moduleUrl: mod("throw new Error('needs a third column');") });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.phase, 'decorate');
  assert.match(thrown.error, /third column/);

  const missing = await run({ block: 'cards', html: HTML, moduleUrl: 'data:text/javascript,syntax error here' });
  assert.equal(missing.phase, 'import');

  const slow = await run({
    block: 'cards', html: HTML, moduleUrl: mod('return new Promise(() => {});'), timeoutMs: 50,
  });
  assert.equal(slow.timedOut, true);
});

test('harness only answers this site\'s origins', () => {
  const own = new URL('https://feat--site--acme.aem.page/tools/block-source/dryrun.html');
  assert.ok(allowedParent('https://main--site--acme.aem.page', own));
  assert.ok(allowedParent('https://main--site--acme.preview.da.live', own), 'DA serves library plugins from its preview proxy');
  assert.ok(!allowedParent('https://main--other--acme.aem.page', own));
  assert.ok(!allowedParent('https://evil.example', own));
  assert.ok(!allowedParent('http://localhost:3000', own));
});

test('agent applies a branch block to the canvas and reverts it', async () => {
  document.querySelector('main').innerHTML = '<div class="section"><div class="cards-wrapper"><div class="cards block" data-block-name="cards"><div><div>Old</div></div></div></div></div>';
  const original = document.querySelector('[data-block-name="cards"]');
  const r = await agent.apply({
    block: 'cards',
    instance: 0,
    html: '<div class="cards"><div><div>New</div></div></div>',
    moduleUrl: mod("block.dataset.decorated = 'yes';"),
    cssUrl: 'https://feat--site--acme.aem.page/blocks/cards/cards.css',
    branch: 'feat',
    sha: 'b'.repeat(40),
  });
  assert.equal(r.ok, true);
  const now = document.querySelector('main .cards');
  assert.equal(now.dataset.decorated, 'yes');
  assert.equal(now.dataset.blockSourceRef, 'feat');
  assert.equal(now.textContent, 'New');
  assert.ok(document.querySelector('link[data-block-source="cards"]'));
  assert.match(document.body.textContent, /Previewing 1 block from feat/);
  assert.deepEqual(agent.list().map((p) => p.id), ['cards:0']);

  await agent.revertAll();
  assert.equal(document.querySelector('main .cards'), original);
  assert.equal(document.querySelector('link[data-block-source]'), null);
  assert.ok(!/Previewing/.test(document.body.textContent));

  await assert.rejects(agent.apply({ block: 'hero', html: '<div class="hero"></div>', moduleUrl: mod('') }), /not found on the canvas/);
  await assert.rejects(agent.apply({ block: 'cards', html: '<div class="cards"></div>', moduleUrl: mod("throw new Error('bad');") }), /bad/);
  assert.equal(document.querySelector('main .cards'), original, 'a failed apply restores the original');
});

test('canvas transport: plugin ⇄ bridge ⇄ agent, scoped to this tab and site', async () => {
  const { connectCanvas, watchCanvas, TAB_KEY } = await import('../tools/block-source/lib/canvas.js');
  const { startBridge } = await import('../tools/block-source/bridge.js');
  // In-memory BroadcastChannel: delivers to the other members of the same name, asynchronously.
  const members = new Set();
  const createChannel = () => {
    const ch = {
      onmessage: null,
      postMessage: (data) => members.forEach((m) => m !== ch && setTimeout(() => m.onmessage?.({ data: structuredClone(data) }))),
      close: () => members.delete(ch),
    };
    members.add(ch);
    return ch;
  };
  const storage = (tab) => {
    const map = new Map(tab ? [[TAB_KEY, tab]] : []);
    return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  };
  // A bridge whose parent is the canvas agent of `site`, in browser tab `tab`.
  const canvasIn = (tab, site) => {
    const listeners = [];
    const bridgeWin = {
      location: { ancestorOrigins: [`https://main--${site}--acme.preview.da.live`] },
      sessionStorage: storage(tab),
      addEventListener: (_, fn) => listeners.push(fn),
      parent: {
        postMessage: async (data) => {
          const reply = data.type === 'block-source:bridge-ready'
            ? agent.readyAnnouncement({ org: 'acme', site })
            : await agent.handle(data, { org: 'acme', site });
          if (reply) listeners.forEach((fn) => fn({ source: bridgeWin.parent, origin: `https://main--${site}--acme.preview.da.live`, data: reply }));
        },
      },
    };
    return startBridge(bridgeWin, createChannel);
  };

  document.querySelector('main').innerHTML = '<div class="cards block" data-block-name="cards"><div><div>Old</div></div></div>';
  const pluginStorage = storage();
  let announced = 0;
  const stopWatching = watchCanvas({ org: 'acme', site: 'site' }, () => { announced += 1; }, { storage: pluginStorage, createChannel });
  const other = canvasIn('another-tab', 'site');
  const wrongSite = canvasIn(pluginStorage.getItem(TAB_KEY), 'other');
  assert.equal(await connectCanvas({ org: 'acme', site: 'site' }, { storage: pluginStorage, createChannel, helloTimeout: 100 }), null, 'a canvas in another tab never answers');
  assert.equal(announced, 0, 'agents of another tab or site are not announced');

  // The canvas loads after the panel opened: its agent announces itself, so the panel need not wait.
  const mine = canvasIn(pluginStorage.getItem(TAB_KEY), 'site');
  await new Promise((r) => { setTimeout(r, 20); });
  assert.equal(announced, 1, 'the agent announces itself once it starts');
  stopWatching();
  const canvas = await connectCanvas({ org: 'acme', site: 'site' }, { storage: pluginStorage, createChannel, helloTimeout: 500 });
  assert.equal(canvas.mode, 'channel');
  await canvas.agent.apply({
    block: 'cards', html: '<div class="cards"><div><div>New</div></div></div>', moduleUrl: mod(''), branch: 'feat', sha: 'c'.repeat(40),
  });
  assert.equal(document.querySelector('main .cards').textContent, 'New');
  assert.deepEqual((await canvas.agent.list()).map((p) => p.id), ['cards:0']);
  await assert.rejects(canvas.agent.apply({ block: 'hero', html: '<div class="hero"></div>', moduleUrl: mod('') }), (e) => e.phase === 'find');
  await canvas.agent.revertAll();
  assert.equal(document.querySelector('main .cards').textContent, 'Old');

  assert.equal(await agent.handle({ type: 'block-source:agent-list', org: 'acme', site: 'other' }, { org: 'acme', site: 'site' }), null, 'the agent ignores commands for another site');
  [other, wrongSite, mine].forEach((c) => c.close());
  canvas.close();
});
