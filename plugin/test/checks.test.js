import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDryRun, hintMessages, combineVerdict } from '../tools/block-source/lib/checks.js';
import { runDryRun } from '../tools/block-source/lib/dryrun-runner.js';

const m = (words, links = 0, images = 0, height = 100) => ({
  words: words.split(' ').filter(Boolean), links, images, height,
});

test('dry run passes when all authored content survives, even with added text', () => {
  const r = evaluateDryRun({ ok: true, before: m('one two two'), after: m('two one read more two') });
  assert.equal(r.pass, true);
});

test('dry run fails on lost words, links, images, errors and timeouts', () => {
  const lost = evaluateDryRun({ ok: true, before: m('alpha beta beta', 2, 1), after: m('alpha beta', 1, 0) });
  assert.equal(lost.pass, false);
  assert.deepEqual(lost.reasons.map((x) => x.code), ['text-lost', 'links-lost', 'images-lost']);
  assert.match(lost.reasons[0].message, /1 word, for example “beta”/);
  assert.equal(evaluateDryRun({ ok: false, phase: 'decorate', error: 'x is undefined' }).reasons[0].code, 'error');
  assert.equal(evaluateDryRun({ ok: false, timedOut: true }).reasons[0].code, 'timeout');
  assert.equal(evaluateDryRun({ ok: true, before: m('a'), after: m('a', 0, 0, 0) }).reasons[0].code, 'empty');
});

test('hints are phrased against the author content', () => {
  const msgs = hintMessages([{ code: 'more-cells', from: 2, to: 3 }, { code: 'new-variant', variant: 'dark' }], { rows: 3, maxCells: 2 });
  assert.equal(msgs[0].message, 'This version needs three columns in each row. Your content has two.');
  assert.equal(msgs[1].info, true);
  assert.equal(hintMessages([{ code: 'more-cells', from: 2, to: 3 }], { rows: 1, maxCells: 3 }).length, 0);
});

test('combineVerdict: gates decide, dry run decides when needed', () => {
  const blocked = { verdict: 'blocked', decidedBy: 'gate1', reasons: [{ code: 'removed', message: 'x' }], hints: [] };
  assert.equal(combineVerdict(blocked, null, null).verdict, 'blocked');
  const needs = { verdict: 'needs-dry-run', reasons: [], hints: [{ code: 'more-cells', from: 2, to: 3 }] };
  assert.equal(combineVerdict(needs, null, null).verdict, 'unknown');
  const pass = combineVerdict(needs, { ok: true, before: m('a b'), after: m('a b c') }, { rows: 1, maxCells: 3 });
  assert.equal(pass.verdict, 'safe');
  assert.equal(pass.decidedBy, 'gate3');
  const fail = combineVerdict(needs, { ok: true, before: m('a b'), after: m('a') }, { rows: 1, maxCells: 2 });
  assert.equal(fail.verdict, 'blocked');
  assert.deepEqual(fail.reasons.map((r) => r.code), ['text-lost', 'more-cells']);
});

test('runDryRun falls back through the three strategies', async () => {
  const calls = [];
  const run = async ({ src, payload }) => {
    calls.push([src, Boolean(payload.code)]);
    if (src.startsWith('https://feat--')) return { unavailable: true };
    if (!payload.code) return { ok: false, phase: 'import', error: 'CORS' };
    return { ok: true, before: m('a'), after: m('a') };
  };
  const r = await runDryRun({
    block: 'cards',
    html: '<div class="cards"></div>',
    previewOrigin: 'https://feat--site--acme.aem.page',
    ownOrigin: 'https://main--site--acme.aem.page',
    getModule: async () => ({ moduleUrl: 'https://feat--site--acme.aem.page/blocks/cards/cards.js', code: 'export default () => {}' }),
    run,
  });
  assert.equal(r.strategy, 'module-source');
  assert.deepEqual(calls.map((c) => c[1]), [false, false, true]);
  assert.equal(r.tried.length, 2);
  const decorateFailure = await runDryRun({
    block: 'cards', html: '', previewOrigin: 'https://feat--site--acme.aem.page', ownOrigin: 'x', getModule: async () => ({}), run: async () => ({ ok: false, phase: 'decorate', error: 'boom' }),
  });
  assert.equal(decorateFailure.strategy, 'branch-origin');
  assert.equal(decorateFailure.error, 'boom');
});

test('runDryRun on its own hosting skips the branch-origin harness and loads site code from the branch', async () => {
  const calls = [];
  const r = await runDryRun({
    block: 'cards',
    html: '',
    previewOrigin: 'https://feat--site--acme.aem.page',
    ownOrigin: 'https://ns.adobeio-static.net',
    harnessOnBranch: false,
    getModule: async () => ({}),
    run: async ({ src, payload }) => {
      calls.push(src);
      assert.equal(payload.codeOrigin, 'https://feat--site--acme.aem.page');
      return { ok: true };
    },
  });
  assert.equal(r.strategy, 'module-url');
  assert.deepEqual(calls, ['https://ns.adobeio-static.net/tools/block-source/dryrun.html']);
});
