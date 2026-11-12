'use strict';

const { resolveBlock, commitSummary } = require('./blocks');
const { resolveHead } = require('./branches');
const { loadModel, safeJson } = require('./contract');
const { domSignature } = require('./signature');

const IMMUTABLE_TTL = 30 * 24 * 3600;
const usagePath = (org, site) => `usage/${org}/${site}.json`;

function plainMarkdown(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => plainMarkdown(c));
}

/** README.md: first paragraph = description, first table = authoring model, "Variants" list, "Sample:" link. */
function parseReadme(md) {
  const lines = String(md || '').replace(/^---\n[\s\S]*?\n---\n/, '').split(/\r?\n/);
  const out = {
    description: null, table: null, variants: [], sample: null,
  };
  let inFence = false;
  let para = [];
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        section = heading[1].toLowerCase();
        if (para.length && !out.description) out.description = plainMarkdown(para.join(' '));
        para = [];
      } else if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
        if (!out.table) {
          const headers = splitRow(line);
          const rows = [];
          let j = i + 2;
          while (j < lines.length && /^\s*\|/.test(lines[j])) {
            rows.push(splitRow(lines[j]));
            j += 1;
          }
          out.table = { headers, rows };
          i = j - 1;
        }
      } else if (/^\s*[-*+]\s+/.test(line) && /variant/.test(section)) {
        const m = line.match(/^\s*[-*+]\s+`?([\w-]+)`?/);
        if (m) out.variants.push(m[1]);
      } else if (!line.trim()) {
        if (para.length && !out.description) out.description = plainMarkdown(para.join(' '));
        para = [];
      } else if (!out.description && !/^\s*[-*+>]|^\s*!\[|^\s*</.test(line)) {
        para.push(line.trim());
      }
      const sample = line.match(/sample(?:\s+page)?\s*:\s*(?:\[[^\]]*\]\(([^)\s]+)\)|<?(\S+?)>?)\s*$/i);
      if (sample && !out.sample) out.sample = sample[1] || sample[2];
    }
  }
  if (para.length && !out.description) out.description = plainMarkdown(para.join(' '));
  return out;
}

/** A leading JSDoc-style comment in the block JS: free text, then @content, @variants, @sample tags. */
function parseHeaderComment(js) {
  const m = String(js || '').match(/^\s*(?:(?:import[^;]*;|'use strict';)\s*)*\/\*\*([\s\S]*?)\*\//);
  if (!m) return {};
  const lines = m[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trimEnd());
  const out = { description: [], tags: {} };
  let current = null;
  lines.forEach((l) => {
    const tag = l.match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      current = tag[1].toLowerCase();
      out.tags[current] = tag[2];
    } else if (current) out.tags[current] = `${out.tags[current]} ${l}`.trim();
    else if (l.trim()) out.description.push(l.trim());
  });
  const description = out.description.join(' ').trim() || null;
  if (!description && !Object.keys(out.tags).length) return {};
  return {
    description,
    content: out.tags.content || null,
    variants: out.tags.variants ? out.tags.variants.split(/[\s,]+/).filter(Boolean) : [],
    sample: out.tags.sample || null,
  };
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

/** Phase 4 generated summary: derived from the DOM signature, marked as generated. */
function generateSummary(block, sig) {
  if (!sig) return { description: null, contentShape: null };
  const parts = [`Decorates the ${block} block`];
  if (sig.usesImages) parts.push('and lays out the images in it');
  let shape = null;
  if (sig.maxCellIndex >= 0) {
    const n = sig.maxCellIndex + 1;
    shape = `Each row is read as ${n} column${n > 1 ? 's' : ''}${n <= ORDINALS.length ? `; the ${ORDINALS[n - 1]} column is the last one used` : ''}.`;
  } else if (sig.maxRowIndex >= 0) {
    shape = `Reads at least ${sig.maxRowIndex + 1} row${sig.maxRowIndex ? 's' : ''}.`;
  }
  return { description: `${parts.join(' ')}.`, contentShape: shape };
}

async function lastBlockCommit(gh, deps, sha, block) {
  return deps.cache.value(`last-${gh.owner}-${gh.repo}-${sha}-${block}`, IMMUTABLE_TTL, async () => {
    const [c] = await gh.listCommits({ sha, path: `blocks/${block}`, perPage: 1 });
    return c ? commitSummary(c) : null;
  });
}

async function buildSummary(gh, { block, ref, settings }) {
  const resolved = await resolveBlock(gh, { block, ref, settings });
  if (resolved.kind !== 'code') return { kind: resolved.kind, source: resolved.source || null };
  const f = resolved.files;
  const [readme, js, manifestRaw, model] = await Promise.all([
    f.readme ? gh.getRaw(f.readme, ref) : null,
    f.js ? gh.getRaw(f.js, ref) : null,
    f.manifest ? gh.getRaw(f.manifest, ref) : null,
    loadModel(gh, { block, ref }),
  ]);
  const manifest = safeJson(manifestRaw) || {};
  const rd = readme ? parseReadme(readme) : {};
  const hc = parseHeaderComment(js);
  const sig = js ? domSignature(js) : null;
  const gen = generateSummary(block, sig);
  const generated = [];

  let description = rd.description || hc.description || manifest.description || null;
  let descriptionSource = (rd.description && 'readme') || (hc.description && 'js-comment') || (manifest.description && 'manifest') || null;
  if (!description && gen.description) {
    description = gen.description;
    descriptionSource = 'generated';
    generated.push('description');
  }

  let contentShape = null;
  if (rd.table) contentShape = { type: 'table', source: 'readme', ...rd.table };
  else if (manifest.rows || manifest.cells) {
    const cells = Array.isArray(manifest.cells) ? manifest.cells : [];
    contentShape = {
      type: 'text',
      source: 'manifest',
      text: [manifest.rows && `Rows: ${manifest.rows}.`,
        cells.length && cells.map((c, i) => `Column ${i + 1} is the ${c}.`).join(' ')].filter(Boolean).join(' '),
      cells,
    };
  } else if (model) contentShape = { type: 'fields', source: model.source, fields: model.fields };
  else if (hc.content) contentShape = { type: 'text', source: 'js-comment', text: hc.content };
  else if (gen.contentShape) {
    contentShape = { type: 'text', source: 'generated', text: gen.contentShape };
    generated.push('contentShape');
  }

  let variants = [...new Set([...(rd.variants || []), ...(manifest.variants || []), ...(hc.variants || [])])];
  let variantsSource = variants.length ? 'declared' : null;
  if (!variants.length && sig && sig.variants.length) {
    variants = sig.variants;
    variantsSource = 'generated';
    generated.push('variants');
  }

  return {
    kind: 'code',
    files: f,
    description,
    descriptionSource,
    contentShape,
    variants,
    variantsSource,
    fields: model ? model.fields : null,
    contract: manifest.contentContract || null,
    sample: manifest.samplePage || rd.sample || hc.sample || null,
    generated,
  };
}

/** Feature 3: the author summary. Cached until the block's last commit changes. */
async function blockSummary(gh, deps, {
  org, site, block, ref, record,
}) {
  const active = await resolveHead(gh, deps, ref);
  const last = await lastBlockCommit(gh, deps, active.sha, block);
  const key = `sum-${gh.owner}-${gh.repo}-${block}-${last ? last.sha : active.sha}`;
  const summary = await deps.cache.value(key, IMMUTABLE_TTL, () => buildSummary(gh, {
    block, ref: active.sha, settings: record.settings || {},
  }));
  const usage = await deps.files.readJson(usagePath(org, site)).catch(() => null);
  const usedOn = usage
    ? {
      count: (usage.blocks[block] && usage.blocks[block].count) || 0,
      pages: (usage.blocks[block] && usage.blocks[block].pages) || [],
      variants: (usage.blocks[block] && usage.blocks[block].variants) || null,
      total: usage.pages,
      scannedAt: usage.scannedAt,
      complete: usage.complete,
    }
    : null;
  return {
    ...summary,
    block,
    activeRef: active.name,
    lastChanged: last ? {
      date: last.date, author: last.author, sha: last.sha, shortSha: last.shortSha, subject: last.subject, url: last.url,
    } : null,
    usedOn,
  };
}

module.exports = {
  parseReadme, parseHeaderComment, generateSummary, buildSummary, blockSummary, usagePath,
};
