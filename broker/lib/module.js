'use strict';

const { HttpError } = require('./http');
const { previewability } = require('./blocks');
const { resolveHead } = require('./branches');

/**
 * Rewrites relative module specifiers to absolute URLs on the branch origin,
 * so the module can be imported from a blob: URL and still load its dependencies.
 */
function rewriteImports(code, moduleUrl) {
  const abs = (spec) => (/^(\.{1,2}\/|\/(?!\/))/.test(spec) ? new URL(spec, moduleUrl).href : spec);
  return code
    .replace(/(\bfrom\s*)(['"])([^'"\n]+)\2/g, (m, a, q, s) => `${a}${q}${abs(s)}${q}`)
    .replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g, (m, a, q, s) => `${a}${q}${abs(s)}${q}`)
    .replace(/(\bimport\s+)(['"])([^'"\n]+)\2/g, (m, a, q, s) => `${a}${q}${abs(s)}${q}`)
    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(moduleUrl));
}

/** Fallback when a cross-origin dynamic import is not possible (CORS, private repositories). */
async function blockModule(gh, deps, {
  org, site, block, branch,
}) {
  const preview = previewability(branch, site, org);
  if (!preview.previewable) throw new HttpError(400, 'not-previewable', preview.reason);
  const head = await resolveHead(gh, deps, branch);
  const path = `blocks/${block}/${block}.js`;
  const code = await deps.cache.value(`mod-${gh.owner}-${gh.repo}-${head.sha}-${block}`, 24 * 3600, async () => gh.getRaw(path, head.sha));
  if (code === null) throw new HttpError(404, 'not-found', 'The block has no JavaScript on this branch.');
  const moduleUrl = `${preview.origin}/${path}`;
  return {
    branch, sha: head.sha, moduleUrl, cssUrl: `${preview.origin}/blocks/${block}/${block}.css`, code: rewriteImports(code, moduleUrl),
  };
}

module.exports = { rewriteImports, blockModule };
