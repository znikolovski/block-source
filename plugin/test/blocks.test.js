import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom.js';
import {
  listBlocks, blockAtIndex, describe, parseHtml,
} from '../tools/block-source/lib/blocks.js';

installDom();

// The shape DA sends in subscribeLiveDocument: full document, editor attributes on blocks.
const LIVE = `<body><header></header><main>
  <div>
    <p>Intro</p>
    <div class="hero dark" data-block-index="3" data-prose-index="12"><div><div><h1 data-cursor-x="1">Hello</h1></div></div></div>
    <div class="metadata"><div><div>title</div><div>x</div></div></div>
  </div>
  <div>
    <div class="library-metadata"><div><div>name</div><div>x</div></div></div>
    <div class="cards"><div><div><img src="a.png" data-image-index="0" onerror="alert(1)"></div><div><p>One</p></div></div><div><div>x</div><div><a href="javascript:alert(1)">bad</a></div></div></div>
    <div class="section-metadata"><div><div>style</div><div>dark</div></div></div>
  </div>
  <div>
    <div class="cards featured"><div><div>a</div><div>b</div><div>c</div></div></div>
  </div>
</main><footer></footer></body>`;

test('listBlocks: ordinals match DA blockIndex (metadata skipped, library-metadata counted)', () => {
  const doc = parseHtml(LIVE);
  const blocks = listBlocks(doc);
  assert.deepEqual(blocks.map((b) => [b.name, b.ordinal, b.instance]), [
    ['hero', 0, 0],
    ['cards', 2, 0],
    ['cards', 3, 1],
  ]);
  assert.equal(blockAtIndex(doc, 1), null); // library-metadata
  assert.equal(blockAtIndex(doc, 3).variants[0], 'featured');
  assert.equal(blockAtIndex(doc, -1), null);
});

test('describe strips editor attributes and unsafe markup', () => {
  const doc = parseHtml(LIVE);
  const hero = describe(blockAtIndex(doc, 0));
  assert.equal(hero.name, 'hero');
  assert.deepEqual(hero.variants, ['dark']);
  assert.ok(!/data-(block|prose|cursor)/.test(hero.html), hero.html);
  const cards = describe(blockAtIndex(doc, 2));
  assert.ok(!cards.html.includes('onerror'));
  assert.ok(!cards.html.includes('javascript:'));
  assert.ok(!cards.html.includes('data-image-index'));
  assert.deepEqual(cards.shape, { rows: 2, maxCells: 2 });
});

test('.plain.html (sections at top level) parses the same way', () => {
  const doc = parseHtml('<main><div><div class="cards"><div><div>a</div></div></div></div></main>');
  assert.equal(listBlocks(doc)[0].name, 'cards');
});
