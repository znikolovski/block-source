'use strict';

const { HttpError } = require('./http');
const {
  previewability, touchesBlock, isSharedModelFile, commitSummary,
} = require('./blocks');
const { pool } = require('./util');

// Short: authors expect a branch they just pushed to show up. Compares are cached by SHA, so this is one list call.
const BRANCH_TTL = 60;
const PULLS_TTL = 5 * 60;
const IMMUTABLE_TTL = 7 * 24 * 3600;
const INDEX_FRESH_MS = 15 * 60 * 1000;
const CONCURRENCY = 8;

const indexPath = (org, site) => `index/${org}/${site}.json`;

function globToRe(glob) {
  return new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

function isProtected(name, patterns = []) {
  return patterns.some((p) => globToRe(p).test(name));
}

async function branchList(gh, deps, { fresh = false } = {}) {
  return deps.cache.wrap(`br-${gh.owner}-${gh.repo}`, BRANCH_TTL, async () => {
    const { branches, truncated } = await gh.listBranches();
    return {
      truncated,
      branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha, protected: Boolean(b.protected) })),
    };
  }, { force: fresh });
}

async function resolveHead(gh, deps, ref, opts) {
  const { value, stale, cachedAt } = await branchList(gh, deps, opts);
  // Preview hostnames are lower case, so a ref from the hostname may differ in case from the branch.
  const found = value.branches.find((b) => b.name === ref)
    || value.branches.find((b) => b.name.toLowerCase() === ref.toLowerCase());
  if (found) return { name: found.name, sha: found.sha, list: value, stale, cachedAt };
  if (/^[0-9a-f]{40}$/.test(ref)) return { name: ref, sha: ref, list: value, stale, cachedAt };
  throw new HttpError(404, 'ref-not-found', `The branch "${ref}" does not exist in the repository.`);
}

function quotedTokens(patch) {
  const set = new Set();
  (patch || '').replace(/"([A-Za-z0-9_-]{1,64})"/g, (_, t) => {
    if (set.size < 200) set.add(t.toLowerCase());
    return _;
  });
  return [...set];
}

/**
 * Compare two commits and keep only what the plugin needs. Keyed by both SHAs,
 * so the result is immutable and shared by every block on the page.
 */
async function compareCompact(gh, deps, baseSha, headSha) {
  return deps.cache.value(`cmp-${gh.owner}-${gh.repo}-${baseSha}-${headSha}`, IMMUTABLE_TTL, async () => {
    const data = await gh.compare(baseSha, headSha);
    const commits = data.commits || [];
    const last = commits[commits.length - 1];
    return {
      baseSha,
      headSha,
      status: data.status,
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      mergeBase: data.merge_base_commit && data.merge_base_commit.sha,
      headDate: last ? (last.commit.committer && last.commit.committer.date) : null,
      newest: last ? commitSummary(last) : null,
      commitShas: commits.map((c) => c.sha),
      files: (data.files || []).map((f) => ({
        filename: f.filename,
        status: f.status,
        previous: f.previous_filename || undefined,
        mentions: isSharedModelFile(f.filename) ? quotedTokens(f.patch) : undefined,
      })),
    };
  });
}

async function openPulls(gh, deps) {
  try {
    return await deps.cache.value(`prs-${gh.owner}-${gh.repo}`, PULLS_TTL, async () => {
      const pulls = await gh.listOpenPulls();
      return pulls
        .filter((p) => p.head && p.head.repo && p.head.repo.full_name === `${gh.owner}/${gh.repo}`)
        .map((p) => ({
          number: p.number,
          title: p.title,
          url: p.html_url,
          state: p.state,
          draft: Boolean(p.draft),
          headRef: p.head.ref,
          author: p.user && p.user.login,
        }));
    });
  } catch (e) {
    if (e.code === 'forbidden' || e.code === 'not-found') return null;
    throw e;
  }
}

async function blockCommitsOnBranch(gh, deps, headSha, block) {
  return deps.cache.value(`bc-${gh.owner}-${gh.repo}-${headSha}-${block}`, IMMUTABLE_TTL, async () => {
    const commits = await gh.listCommits({ sha: headSha, path: `blocks/${block}`, perPage: 100 });
    return commits.map(commitSummary);
  });
}

/** How the active ref relates to the default branch, so authors on a release branch see they are behind. */
async function refRelation(gh, deps, active, defaultBranch) {
  if (active.name === defaultBranch) return { activeRef: active.name, isDefault: true, defaultBranch };
  const def = active.list.branches.find((b) => b.name === defaultBranch);
  if (!def) return { activeRef: active.name, isDefault: false, defaultBranch };
  const cmp = await compareCompact(gh, deps, def.sha, active.sha);
  return {
    activeRef: active.name,
    isDefault: false,
    defaultBranch,
    aheadOfDefault: cmp.aheadBy,
    behindDefault: cmp.behindBy,
  };
}

async function loadIndex(deps, org, site) {
  try {
    return await deps.files.readJson(indexPath(org, site));
  } catch {
    return null;
  }
}

function candidateBranches(list, { activeRef, defaultBranch, settings = {} }) {
  return list.branches.filter((b) => b.name !== activeRef
    && b.name !== defaultBranch
    && !isProtected(b.name, settings.protectedBranches));
}

/**
 * Feature 2: branches with a newer version of the block.
 * Uses the warm index when it was built for this base, otherwise compares live,
 * in parallel with a cap of 8, and caches every comparison by SHA pair.
 */
async function newerVersions(gh, deps, {
  org, site, block, ref, record, fresh = false,
}) {
  const settings = record.settings || {};
  const defaultBranch = settings.defaultBranch || (record.meta && record.meta.defaultBranch) || 'main';
  const active = await resolveHead(gh, deps, ref, { fresh });
  const all = candidateBranches(active.list, { activeRef: active.name, defaultBranch, settings });
  const maxBranches = deps.config.maxBranches;

  const index = await loadIndex(deps, org, site);
  const indexUsable = index && index.baseSha === active.sha
    && deps.now() - Date.parse(index.generatedAt) < INDEX_FRESH_MS;
  const candidates = indexUsable
    ? all.filter((b) => index.branchShas[b.name] !== b.sha || (index.blocks[block] || []).includes(b.name))
    : all;
  const scanned = candidates.slice(0, maxBranches);

  const cutoff = deps.now() - deps.config.activityDays * 24 * 3600 * 1000;
  const compares = await pool(scanned, CONCURRENCY, async (b) => {
    try {
      return { branch: b, cmp: await compareCompact(gh, deps, active.sha, b.sha) };
    } catch (e) {
      if (e.upstream) throw e;
      deps.log.info('compare failed', b.name, e.code);
      return null;
    }
  });

  const matched = compares.filter((x) => x
    && x.cmp.aheadBy > 0
    && x.cmp.headDate && Date.parse(x.cmp.headDate) >= cutoff
    && x.cmp.files.some((f) => touchesBlock(f, block)));

  const pulls = await openPulls(gh, deps).catch(() => null);
  const results = await pool(matched, CONCURRENCY, async ({ branch, cmp }) => {
    const shas = new Set(cmp.commitShas);
    const blockCommits = (await blockCommitsOnBranch(gh, deps, branch.sha, block)).filter((c) => shas.has(c.sha));
    const preview = previewability(branch.name, site, org);
    const pr = pulls ? pulls.find((p) => p.headRef === branch.name) || null : undefined;
    return {
      name: branch.name,
      sha: branch.sha,
      previewable: preview.previewable,
      previewReason: preview.reason,
      previewOrigin: preview.origin || null,
      aheadBy: cmp.aheadBy,
      behindBy: cmp.behindBy,
      blockAheadBy: blockCommits.length,
      files: cmp.files.filter((f) => touchesBlock(f, block)).map((f) => ({ path: f.filename, status: f.status })),
      newest: blockCommits[0] || cmp.newest,
      headDate: cmp.headDate,
      pr,
      compareUrl: `https://github.com/${gh.owner}/${gh.repo}/compare/${encodeURIComponent(active.name)}...${encodeURIComponent(branch.name)}`,
    };
  });
  results.sort((a, b) => Date.parse(b.headDate) - Date.parse(a.headDate));

  return {
    activeRef: active.name,
    activeSha: active.sha,
    relation: await refRelation(gh, deps, active, defaultBranch),
    branches: results,
    scanned: scanned.length,
    candidates: all.length,
    truncated: candidates.length > scanned.length || active.list.truncated,
    pullsAvailable: pulls !== null,
    fromIndex: Boolean(indexUsable),
    stale: active.stale,
    cachedAt: active.cachedAt,
  };
}

/** Builds the warm index: block -> branches, for the default branch. */
async function buildIndex(gh, deps, { org, site, record }) {
  const settings = record.settings || {};
  const defaultBranch = settings.defaultBranch || (record.meta && record.meta.defaultBranch) || 'main';
  const active = await resolveHead(gh, deps, defaultBranch);
  const all = candidateBranches(active.list, { activeRef: defaultBranch, defaultBranch, settings });
  const cutoff = deps.now() - deps.config.activityDays * 24 * 3600 * 1000;
  const blocks = {};
  const branchShas = {};
  await pool(all.slice(0, deps.config.maxBranches * 3), CONCURRENCY, async (b) => {
    branchShas[b.name] = b.sha;
    let cmp;
    try {
      cmp = await compareCompact(gh, deps, active.sha, b.sha);
    } catch (e) {
      if (e.upstream) throw e;
      return;
    }
    if (!cmp.aheadBy || !cmp.headDate || Date.parse(cmp.headDate) < cutoff) return;
    const names = new Set();
    cmp.files.forEach((f) => {
      const m = f.filename.match(/^blocks\/([^/]+)\//);
      if (m) names.add(m[1]);
      (f.mentions || []).forEach((t) => names.add(t));
      const model = f.filename.match(/^models\/_([^/]+)\.json$/);
      if (model) names.add(model[1]);
    });
    names.forEach((n) => {
      blocks[n] = blocks[n] || [];
      blocks[n].push(b.name);
    });
  });
  const index = {
    generatedAt: new Date(deps.now()).toISOString(),
    baseRef: defaultBranch,
    baseSha: active.sha,
    branchShas,
    blocks,
  };
  await deps.files.writeJson(indexPath(org, site), index);
  return index;
}

module.exports = {
  branchList,
  resolveHead,
  compareCompact,
  openPulls,
  blockCommitsOnBranch,
  refRelation,
  newerVersions,
  buildIndex,
  isProtected,
  candidateBranches,
  indexPath,
};
