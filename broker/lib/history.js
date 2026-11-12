'use strict';

const { resolveBlock, groupFiles, commitSummary } = require('./blocks');
const { resolveHead, refRelation } = require('./branches');
const { pool } = require('./util');

const HISTORY_SIZE = 20;
const IMMUTABLE_TTL = 7 * 24 * 3600;

async function commitFiles(gh, deps, sha) {
  return deps.cache.value(`cf-${gh.owner}-${gh.repo}-${sha}`, IMMUTABLE_TTL, async () => {
    const data = await gh.getCommit(sha);
    return (data.files || []).map((f) => ({ filename: f.filename, status: f.status }));
  });
}

/**
 * Feature 1: the last 20 commits that touched blocks/{name}/ on the active ref.
 * The first entry is the branch head for this path, which code sync deploys,
 * so it is marked as the commit in use. Cached by branch head SHA.
 */
async function blockHistory(gh, deps, {
  block, ref, record,
}) {
  const active = await resolveHead(gh, deps, ref);
  const settings = record.settings || {};
  const defaultBranch = settings.defaultBranch || (record.meta && record.meta.defaultBranch) || 'main';

  const { value, stale, cachedAt } = await deps.cache.wrap(
    `hist-${gh.owner}-${gh.repo}-${block}-${active.sha}`,
    IMMUTABLE_TTL,
    async () => {
      const resolved = await resolveBlock(gh, { block, ref: active.sha, settings });
      if (resolved.kind !== 'code') return { resolved, commits: [] };
      const commits = await gh.listCommits({ sha: active.sha, path: `blocks/${block}`, perPage: HISTORY_SIZE });
      const files = await pool(commits, 8, (c) => commitFiles(gh, deps, c.sha).catch(() => []));
      return {
        resolved,
        commits: commits.map((c, i) => ({
          ...commitSummary(c),
          files: groupFiles(files[i], block),
          inUse: i === 0,
        })),
      };
    },
  );

  return {
    ...value,
    activeRef: active.name,
    activeSha: active.sha,
    relation: await refRelation(gh, deps, active, defaultBranch).catch(() => null),
    repoUrl: `https://github.com/${gh.owner}/${gh.repo}`,
    stale: stale || active.stale,
    cachedAt,
  };
}

module.exports = { blockHistory, commitFiles };
