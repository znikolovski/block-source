import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHost, resolveRef, previewOrigin, siteContext, LOCAL_REF_KEY,
} from '../tools/block-source/lib/ref.js';

const storage = (v) => ({ getItem: (k) => (k === LOCAL_REF_KEY ? v : null) });

test('parseHost', () => {
  assert.deepEqual(parseHost('feature-x--site--acme.aem.page'), {
    ref: 'feature-x', site: 'site', org: 'acme', tier: 'page',
  });
  assert.deepEqual(parseHost('feature-x--site--acme.preview.da.live'), {
    ref: 'feature-x', site: 'site', org: 'acme', tier: 'preview',
  });
  assert.equal(parseHost('example.com'), null);
  assert.equal(parseHost('a--b--c.aem.page.evil.com'), null);
});

test('resolveRef precedence: hostname, ?ref, local override, main', () => {
  assert.deepEqual(resolveRef({ hostname: 'feat--site--acme.aem.page', search: '?ref=other' }, storage('x')), { ref: 'feat', source: 'hostname' });
  assert.deepEqual(resolveRef({ hostname: 'localhost', search: '?ref=other' }, storage('x')), { ref: 'other', source: 'query' });
  assert.deepEqual(resolveRef({ hostname: 'localhost', search: '' }, storage('mine')), { ref: 'mine', source: 'local-override' });
  assert.deepEqual(resolveRef({ hostname: 'example.com', search: '' }, storage('mine')), { ref: 'main', source: 'default' });
  assert.deepEqual(resolveRef({ hostname: 'localhost', search: '?ref=bad ref' }, null), { ref: 'main', source: 'default' });
});

test('previewOrigin follows the hostname rules', () => {
  assert.equal(previewOrigin('Feature-X', 'site', 'acme'), 'https://feature-x--site--acme.aem.page');
  assert.equal(previewOrigin('feature/x', 'site', 'acme'), null);
  assert.equal(previewOrigin('x'.repeat(60), 'site', 'acme'), null);
});

test('siteContext prefers the SDK context', () => {
  const loc = { hostname: 'main--site--acme.aem.page', search: '' };
  assert.deepEqual(siteContext({ org: 'Acme', repo: 'Site', path: '/drafts/page.html' }, loc), { org: 'acme', site: 'site', path: '/drafts/page' });
  assert.deepEqual(siteContext({}, loc), { org: 'acme', site: 'site', path: '/' });
});
