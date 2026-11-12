'use strict';

const { HttpError } = require('./http');

const SHARED_MODEL_FILES = ['component-models.json', 'component-definition.json', 'component-filters.json'];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const REF_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
const ORG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

function assertName(value, field = 'block') {
  if (!NAME_RE.test(value || '')) throw new HttpError(400, 'bad-request', `Invalid ${field}.`);
  return value.toLowerCase();
}

function assertRef(value, field = 'ref') {
  if (!REF_RE.test(value || '')) throw new HttpError(400, 'bad-request', `Invalid ${field}.`);
  return value;
}

function assertOrg(value, field) {
  if (!ORG_RE.test(value || '')) throw new HttpError(400, 'bad-request', `Invalid ${field}.`);
  return value.toLowerCase();
}

/** A branch has a preview hostname only if it is a valid DNS label: {branch}--{site}--{org}. */
function previewability(branch, site, org) {
  if (!/^[a-z0-9-]+$/i.test(branch)) {
    return {
      previewable: false,
      reason: branch.includes('/')
        ? 'The branch name contains "/", which cannot be part of a preview hostname.'
        : 'The branch name contains characters that cannot be part of a preview hostname.',
    };
  }
  const label = `${branch}--${site}--${org}`;
  if (label.length > 63) {
    return {
      previewable: false,
      reason: `The preview hostname would be ${label.length} characters. The limit is 63.`,
    };
  }
  return { previewable: true, reason: null, origin: `https://${label.toLowerCase()}.aem.page` };
}

function isSharedModelFile(path) {
  return SHARED_MODEL_FILES.includes(path) || /^models\/_[^/]+\.json$/.test(path);
}

/** True when a changed file affects the block: anything under blocks/{name}/, or a shared model file that mentions it. */
function touchesBlock(file, block) {
  const path = file.filename || file.path || file;
  if (path.startsWith(`blocks/${block}/`)) return true;
  if (isSharedModelFile(path)) {
    if (path === `models/_${block}.json`) return true;
    if (Array.isArray(file.mentions)) return file.mentions.includes(block);
    return false;
  }
  return false;
}

function fileKind(path, block) {
  const name = path.split('/').pop();
  if (isSharedModelFile(path) || name === `_${block}.json`) return 'model';
  if (name === 'block.json') return 'manifest';
  if (/\.(m?js)$/.test(name)) return 'js';
  if (/\.css$/.test(name)) return 'css';
  if (/\.(md|txt)$/i.test(name)) return 'docs';
  return 'other';
}

function groupFiles(files, block) {
  const groups = {
    js: [], css: [], model: [], docs: [], other: [],
  };
  files.filter((f) => touchesBlock(f, block)).forEach((f) => {
    const kind = fileKind(f.filename, block);
    (groups[kind === 'manifest' ? 'model' : kind]).push({ path: f.filename, status: f.status });
  });
  return groups;
}

/**
 * Resolves the selected block to a code path.
 * Returns kind: 'code' | 'external' | 'not-code-block'.
 */
async function resolveBlock(gh, { block, ref, settings = {} }) {
  const external = settings.external && settings.external[block];
  if (external) return { kind: 'external', block, source: external };
  const listing = await gh.getContent(`blocks/${block}`, ref);
  if (!Array.isArray(listing)) return { kind: 'not-code-block', block };
  const names = new Set(listing.map((e) => e.name));
  const readme = listing.find((e) => /^readme\.md$/i.test(e.name));
  return {
    kind: 'code',
    block,
    path: `blocks/${block}/`,
    files: {
      js: names.has(`${block}.js`) ? `blocks/${block}/${block}.js` : null,
      css: names.has(`${block}.css`) ? `blocks/${block}/${block}.css` : null,
      readme: readme ? readme.path : null,
      model: names.has(`_${block}.json`) ? `blocks/${block}/_${block}.json` : null,
      manifest: names.has('block.json') ? `blocks/${block}/block.json` : null,
    },
  };
}

function personOf(commit) {
  const c = commit.commit || {};
  const email = (c.author && c.author.email) || null;
  return {
    name: (c.author && c.author.name) || null,
    email,
    noreply: Boolean(email && /users\.noreply\.github\.com$/i.test(email)),
    login: (commit.author && commit.author.login) || null,
    avatarUrl: (commit.author && commit.author.avatar_url) || null,
  };
}

function commitSummary(commit) {
  const message = (commit.commit && commit.commit.message) || '';
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    subject: message.split('\n')[0],
    author: personOf(commit),
    date: (commit.commit && commit.commit.author && commit.commit.author.date) || null,
    committedDate: (commit.commit && commit.commit.committer && commit.commit.committer.date) || null,
    url: commit.html_url || null,
  };
}

module.exports = {
  assertName,
  assertRef,
  assertOrg,
  previewability,
  touchesBlock,
  isSharedModelFile,
  fileKind,
  groupFiles,
  resolveBlock,
  commitSummary,
  personOf,
  SHARED_MODEL_FILES,
};
