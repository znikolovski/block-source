'use strict';

const { gitBlobSha } = require('./crypto');
const { previewability } = require('./blocks');

// Site-specific files decide; aem.js is often unchanged boilerplate, so it only counts as a fallback.
const SITE_FILES = ['scripts/scripts.js', 'styles/styles.css'];
const FALLBACK_FILE = 'scripts/aem.js';

async function servedSha(deps, url) {
  try {
    const res = await deps.fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return null;
    return gitBlobSha(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

async function githubSha(gh, path, ref) {
  try {
    const meta = await gh.getContent(path, ref);
    return (meta && meta.sha) || null;
  } catch {
    return null;
  }
}

/**
 * Checks that the repository is the code source of the DA site: the code served at
 * {branch}--{site}--{org}.aem.live must have the same git blob SHAs as the repository.
 * Returns state 'match', 'mismatch' (the repository is not this site's code) or 'unverified'.
 */
async function verifySiteRepo(gh, deps, { org, site, branch = 'main' }) {
  const host = previewability(branch, site, org).previewable ? branch.toLowerCase() : 'main';
  const origin = `https://${host}--${site}--${org}.aem.live`;
  const files = await Promise.all([...SITE_FILES, FALLBACK_FILE].map(async (path) => {
    const [github, served] = await Promise.all([githubSha(gh, path, branch), servedSha(deps, `${origin}/${path}`)]);
    return {
      path, github, served, match: Boolean(github && served && github === served),
    };
  }));
  const decisive = files.filter((f) => SITE_FILES.includes(f.path));
  const fallback = files.find((f) => f.path === FALLBACK_FILE);
  const comparable = (f) => f.github && f.served;
  let state = 'unverified';
  if (decisive.some((f) => f.match)) state = 'match';
  else if (decisive.some(comparable)) state = 'mismatch';
  else if (fallback.match) state = 'match';
  else if (comparable(fallback)) state = 'mismatch';
  else if (files.some((f) => f.served) && !files.some((f) => f.github)) state = 'mismatch';
  return {
    state,
    origin,
    checkedAt: new Date(deps.now()).toISOString(),
    files: files.map(({ path, match }) => ({ path, match })),
  };
}

module.exports = { verifySiteRepo };
