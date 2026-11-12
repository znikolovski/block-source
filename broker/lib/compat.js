'use strict';

const { HttpError } = require('./http');
const { previewability, touchesBlock } = require('./blocks');
const {
  resolveHead, compareCompact, openPulls, blockCommitsOnBranch,
} = require('./branches');
const {
  loadModel, loadManifest, diffModels, compareContracts,
} = require('./contract');
const { classifyChanges, domSignature, signatureHints } = require('./signature');
const { parseReadme, parseHeaderComment } = require('./summary');

function toUrl(value, origin) {
  if (!value) return null;
  if (/^https:\/\//.test(value)) return value;
  if (value.startsWith('/') && origin) return `${origin}${value}`;
  return null;
}

/**
 * Safe alternative for a blocked verdict: a page on the branch that already uses the new structure.
 * Sources: block.json samplePage, README "Sample:", JS @sample, or the admin's sample path pattern.
 */
async function findSample(gh, deps, {
  block, headSha, origin, settings,
}) {
  if (!origin) return null;
  const [manifest, readme, js] = await Promise.all([
    loadManifest(gh, { block, ref: headSha }),
    gh.getRaw(`blocks/${block}/README.md`, headSha),
    gh.getRaw(`blocks/${block}/${block}.js`, headSha),
  ]);
  const declared = (manifest && manifest.samplePage)
    || (readme && parseReadme(readme).sample)
    || parseHeaderComment(js).sample;
  const url = toUrl(declared, origin);
  if (url) return { url, source: 'declared' };
  if (settings && settings.samplePathPattern) {
    const path = settings.samplePathPattern.replace('{block}', block);
    const candidate = toUrl(path, origin);
    try {
      const res = await deps.fetch(candidate, { method: 'HEAD' });
      if (res.ok) return { url: candidate, source: 'convention' };
    } catch {
      // not available
    }
  }
  return null;
}

/**
 * Gates 1 and 2 for one branch. Gate 3 (the dry run) runs in the browser,
 * because it needs the author's live content; this returns `needs-dry-run` when it is required.
 */
async function compatibility(gh, deps, {
  org, site, block, ref, branch, record,
}) {
  const settings = record.settings || {};
  const base = await resolveHead(gh, deps, ref);
  const found = base.list.branches.find((b) => b.name === branch);
  if (!found) throw new HttpError(404, 'branch-not-found', `The branch "${branch}" does not exist.`);
  const headSha = found.sha;
  const preview = previewability(branch, site, org);
  const cmp = await compareCompact(gh, deps, base.sha, headSha);
  const relevant = cmp.files.filter((f) => touchesBlock(f, block));
  const classes = classifyChanges(relevant, block);

  const result = {
    block,
    ref,
    branch,
    baseSha: base.sha,
    headSha,
    previewable: preview.previewable,
    previewReason: preview.reason,
    previewOrigin: preview.origin || null,
    gates: { gate2: { classes } },
    verdict: null,
    decidedBy: null,
    needsDryRun: false,
    reasons: [],
    hints: [],
  };

  if (!relevant.length) {
    result.verdict = 'safe';
    result.decidedBy = 'gate2';
    result.reasons.push({ code: 'no-change', message: 'This version does not change this block.' });
    return result;
  }

  if (classes.model.length || classes.manifest.length) {
    const [mBase, mHead, cBase, cHead] = await Promise.all([
      loadModel(gh, { block, ref: base.sha }),
      loadModel(gh, { block, ref: headSha }),
      loadManifest(gh, { block, ref: base.sha }),
      loadManifest(gh, { block, ref: headSha }),
    ]);
    const model = diffModels(mBase, mHead);
    const contract = compareContracts(cBase, cHead);
    const unsafe = model.verdict === 'unsafe' || contract.verdict === 'unsafe';
    result.gates.gate1 = {
      model, contract, verdict: unsafe ? 'unsafe' : 'safe',
    };
    if (unsafe) {
      result.verdict = 'blocked';
      result.decidedBy = 'gate1';
      model.changes.filter((c) => c.unsafe).forEach((c) => result.reasons.push({ code: c.kind, message: c.message }));
      if (contract.verdict === 'unsafe') result.reasons.push({ code: 'contract-major', message: contract.message });
    }
  }

  if (classes.js.length) {
    const [jsBase, jsHead] = await Promise.all([
      gh.getRaw(`blocks/${block}/${block}.js`, base.sha),
      gh.getRaw(`blocks/${block}/${block}.js`, headSha),
    ]);
    const sigBase = jsBase ? domSignature(jsBase) : null;
    const sigHead = jsHead ? domSignature(jsHead) : null;
    result.gates.gate2.signature = { base: sigBase, head: sigHead };
    result.hints = signatureHints(sigBase, sigHead);
  }

  if (!result.verdict) {
    if (classes.cssDocsOnly) {
      result.verdict = 'safe';
      result.decidedBy = 'gate2';
      result.reasons.push({
        code: 'styles-or-docs',
        message: classes.css.length ? 'This version only changes styles.' : 'This version only changes documentation.',
      });
    } else if (classes.js.length || classes.other.length || classes.onlyAdded) {
      result.verdict = 'needs-dry-run';
      result.needsDryRun = true;
    } else {
      result.verdict = 'safe';
      result.decidedBy = 'gate1';
      result.reasons.push({ code: 'contract-compatible', message: 'The content model is compatible with your content.' });
    }
  }

  const [commits, pulls] = await Promise.all([
    blockCommitsOnBranch(gh, deps, headSha, block).catch(() => []),
    openPulls(gh, deps).catch(() => null),
  ]);
  const shas = new Set(cmp.commitShas);
  const newest = commits.find((c) => shas.has(c.sha)) || cmp.newest;
  result.contact = {
    author: newest ? newest.author : null,
    commit: newest ? { sha: newest.sha, subject: newest.subject, url: newest.url } : null,
    pr: pulls ? pulls.find((p) => p.headRef === branch) || null : null,
  };
  if (result.verdict !== 'safe') {
    result.sample = await findSample(gh, deps, {
      block, headSha, origin: preview.origin, settings,
    }).catch(() => null);
  }
  return result;
}

module.exports = { compatibility, findSample };
