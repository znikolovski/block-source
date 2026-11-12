'use strict';

const { blockSummary } = require('./summary');
const { newerVersions, resolveHead } = require('./branches');
const { personOf } = require('./blocks');

const ISSUES_TTL = 600;
const OWNERS_TTL = 3600;
const ISSUE_LIMIT = 10;
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** A CODEOWNERS pattern as a regular expression over repository paths (gitignore-style subset). */
function patternRe(pattern) {
  let p = pattern;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);
  const body = p.split('**').map((part) => part
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')).join('.*');
  return new RegExp(`${anchored ? '^' : '(^|/)'}${body}(${dir ? '/' : '(/|$)'}.*)?$`);
}

/** Owners of a path from CODEOWNERS text: the last matching rule wins, as on GitHub. */
function codeOwnersFor(text, path) {
  let owners = null;
  String(text || '').split('\n').forEach((raw) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const [pattern, ...rest] = line.split(/\s+/);
    try {
      if (patternRe(pattern).test(path)) owners = rest;
    } catch {
      // unusable pattern
    }
  });
  return owners;
}

function ownerEntry(handle) {
  if (handle.startsWith('@')) {
    const name = handle.slice(1);
    const team = name.includes('/');
    const [org, slug] = name.split('/');
    return {
      handle,
      kind: team ? 'team' : 'user',
      url: team ? `https://github.com/orgs/${org}/teams/${slug}` : `https://github.com/${name}`,
    };
  }
  return { handle, kind: 'email', url: null };
}

/** Who to contact about a block: CODEOWNERS when it names someone, else the people who changed it most. */
async function blockOwners(gh, deps, { block, sha }) {
  return deps.cache.value(`owners-${gh.owner}-${gh.repo}-${block}-${sha}`, OWNERS_TTL, async () => {
    const path = `blocks/${block}/${block}.js`;
    const files = await Promise.all(CODEOWNERS_PATHS.map((p) => gh.getRaw(p, sha).catch(() => null)));
    const text = files.find((f) => typeof f === 'string');
    const owners = text ? codeOwnersFor(text, path) : null;
    if (owners && owners.length) {
      return { source: 'codeowners', people: owners.map(ownerEntry) };
    }
    const commits = await gh.listCommits({ sha, path: `blocks/${block}`, perPage: 50 });
    const tally = new Map();
    commits.forEach((c) => {
      const p = personOf(c);
      const key = p.login || p.email || p.name;
      if (!key) return;
      const t = tally.get(key) || {
        name: p.name, login: p.login, url: p.login ? `https://github.com/${p.login}` : null, changes: 0, last: null,
      };
      t.changes += 1;
      const date = c.commit && c.commit.author && c.commit.author.date;
      if (date && (!t.last || date > t.last)) t.last = date;
      tally.set(key, t);
    });
    const people = [...tally.values()].sort((a, b) => b.changes - a.changes).slice(0, 3);
    return { source: people.length ? 'commits' : null, people, sampled: commits.length };
  });
}

const issueOf = (i) => ({
  number: i.number,
  title: i.title,
  url: i.html_url,
  updatedAt: i.updated_at,
  labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
  author: i.user && i.user.login,
});

// GitHub's issue list and search can lag a newly created issue by seconds to minutes, so issues
// raised through Block Source are remembered briefly and merged in until GitHub lists them.
const RECENT_TTL = 15 * 60;
const LIST_LAG_MS = 2 * 60 * 1000;
const recentKey = (gh, block) => `issues-recent-${gh.owner}-${gh.repo}-${block}`;

async function rememberIssue(gh, deps, block, created) {
  const key = recentKey(gh, block);
  const list = (await deps.state.get(key).catch(() => null)) || [];
  const item = { ...issueOf(created), match: created.labels && created.labels.length ? 'label' : 'mention' };
  const next = [{ at: deps.now(), item }, ...list.filter((r) => r.item.number !== item.number)].slice(0, 20);
  await deps.state.put(key, next, RECENT_TTL);
  await deps.state.delete(`issues-${gh.owner}-${gh.repo}-${block}`);
}

/** Adds remembered issues the cached list may have missed because it was read too soon after they were raised. */
async function withRecent(gh, deps, block, value, cachedAt) {
  if (value.state !== 'ok') return value;
  const recent = (await deps.state.get(recentKey(gh, block)).catch(() => null)) || [];
  const known = new Set(value.items.map((i) => i.number));
  const missing = recent.filter((r) => cachedAt - r.at < LIST_LAG_MS && !known.has(r.item.number)).map((r) => r.item);
  if (!missing.length) return value;
  const items = [...missing, ...value.items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    ...value,
    open: value.open + missing.length,
    labelled: value.labelled + missing.filter((i) => i.match === 'label').length,
    items: items.slice(0, ISSUE_LIMIT),
  };
}

/**
 * Open issues about a block: labelled block:{name}, or naming the block in the title or body.
 * Needs the Issues: Read permission on fine-grained tokens; reports when it is missing.
 */
async function blockIssues(gh, deps, { block }) {
  const label = `block:${block}`;
  const searchUrl = `https://github.com/${gh.owner}/${gh.repo}/issues?q=${encodeURIComponent(`is:issue is:open label:"${label}" OR "${block}"`)}`;
  try {
    const { value, cachedAt } = await deps.cache.wrap(`issues-${gh.owner}-${gh.repo}-${block}`, ISSUES_TTL, async () => {
      const [labelled, mentioned] = await Promise.all([
        gh.listIssues({ labels: label, perPage: 50 }),
        gh.searchIssues(`is:issue is:open "${block}" in:title,body`, { perPage: 50 }),
      ]);
      const byNumber = new Map();
      labelled.filter((i) => !i.pull_request).forEach((i) => byNumber.set(i.number, { ...issueOf(i), match: 'label' }));
      (mentioned.items || []).filter((i) => !i.pull_request && !byNumber.has(i.number))
        .forEach((i) => byNumber.set(i.number, { ...issueOf(i), match: 'mention' }));
      const items = [...byNumber.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return {
        state: 'ok',
        open: items.length,
        labelled: items.filter((i) => i.match === 'label').length,
        incomplete: Boolean(mentioned.incomplete_results),
        items: items.slice(0, ISSUE_LIMIT),
      };
    });
    return { ...(await withRecent(gh, deps, block, value, cachedAt)), searchUrl };
  } catch (e) {
    if (e.code === 'forbidden') return { state: 'no-permission', searchUrl };
    if (e.code === 'not-found' || e.status === 410) return { state: 'disabled', searchUrl };
    deps.log.info('insights: issues failed', e.code);
    return { state: 'unavailable', searchUrl };
  }
}

function docsStatus(summary) {
  const files = summary.files || {};
  const shapeSource = summary.contentShape && summary.contentShape.source;
  return {
    readme: Boolean(files.readme),
    contentModel: Boolean(files.model || files.manifest || (shapeSource && shapeSource !== 'generated')),
    description: summary.descriptionSource === 'generated' ? 'generated' : (summary.description ? 'written' : 'missing'),
    sample: Boolean(summary.sample),
  };
}

function variantUsage(usedOn, declared) {
  if (!usedOn) return null;
  const counts = { ...(usedOn.variants || {}) };
  (declared || []).forEach((v) => {
    if (!(v in counts)) counts[v] = 0;
  });
  return Object.entries(counts).map(([name, pages]) => ({ name, pages })).sort((a, b) => b.pages - a.pages);
}

/** The block's at-a-glance report for authors. Each part fails on its own without failing the rest. */
async function blockInsights(gh, deps, {
  org, site, block, ref, record,
}) {
  const summary = await blockSummary(gh, deps, {
    org, site, block, ref, record,
  });
  if (summary.kind !== 'code') {
    return {
      block, kind: summary.kind, source: summary.source || null, usedOn: summary.usedOn,
    };
  }
  const active = await resolveHead(gh, deps, ref);
  const [versions, owners, issues] = await Promise.all([
    newerVersions(gh, deps, {
      org, site, block, ref, record,
    }).catch((e) => {
      deps.log.info('insights: versions failed', e.code);
      return null;
    }),
    blockOwners(gh, deps, { block, sha: active.sha }).catch((e) => {
      deps.log.info('insights: owners failed', e.code);
      return null;
    }),
    blockIssues(gh, deps, { block }),
  ]);
  const usedOn = summary.usedOn ? { ...summary.usedOn } : null;
  if (usedOn) delete usedOn.variants;
  return {
    block,
    kind: 'code',
    activeRef: active.name,
    lastChanged: summary.lastChanged,
    usedOn,
    variants: variantUsage(summary.usedOn, summary.variants),
    declaredVariants: summary.variants,
    issues,
    work: versions
      ? {
        branches: versions.branches.map((b) => ({
          name: b.name,
          headDate: b.headDate,
          blockAheadBy: b.blockAheadBy,
          subject: b.newest && b.newest.subject,
          pr: b.pr ? {
            number: b.pr.number, title: b.pr.title, url: b.pr.url, draft: b.pr.draft,
          } : null,
          compareUrl: b.compareUrl,
        })),
        pulls: versions.branches.filter((b) => b.pr).length,
        pullsAvailable: versions.pullsAvailable,
        truncated: versions.truncated,
      }
      : null,
    owners,
    docs: docsStatus(summary),
    repoUrl: `https://github.com/${gh.owner}/${gh.repo}`,
  };
}

module.exports = {
  blockInsights, codeOwnersFor, blockIssues, blockOwners, docsStatus, rememberIssue,
};
