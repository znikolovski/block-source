'use strict';

const crypto = require('crypto');
const { HttpError } = require('./http');
const { rememberIssue } = require('./insights');

const MAX_SHOT_BYTES = 750 * 1024;
const REPORTS_PER_WINDOW = 5;
const WINDOW_MS = 10 * 60 * 1000;
const SHOT_ID = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const PAGE_PATH = /^\/[A-Za-z0-9/_.-]{0,300}$/;

const SHOT_TYPES = {
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  webp: { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
};

const shotPath = (org, site, id) => `shots/${org}/${site}/${id}`;

/** Decodes and checks a `data:image/…;base64,…` screenshot. */
function decodeShot(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'bad-screenshot', 'The screenshot is not a JPEG, PNG or WebP image.');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_SHOT_BYTES) throw new HttpError(413, 'screenshot-too-large', 'The screenshot is too large.');
  if (!SHOT_TYPES[ext].magic.every((byte, i) => buffer[i] === byte)) {
    throw new HttpError(400, 'bad-screenshot', 'The screenshot is not a JPEG, PNG or WebP image.');
  }
  return { ext, buffer };
}

/** The broker's public URL, for links that GitHub can load without a DA token. */
function publicBase(deps) {
  if (deps.config.publicUrl) return deps.config.publicUrl.replace(/\/+$/, '');
  const ns = process.env.__OW_NAMESPACE;
  const action = process.env.__OW_ACTION_NAME;
  if (!ns || !action) return null;
  return `https://${ns.toLowerCase()}.adobeio-static.net/api/v1/web${action.replace(/^\/[^/]+/, '')}`;
}

const oneLine = (s, max) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const code = (s) => `\`${String(s).replace(/`/g, '')}\``;

function issueBody({
  details, block, branch, sha, gh, org, site, page, shotUrl, reporter,
}) {
  const tree = `https://github.com/${gh.owner}/${gh.repo}/tree/${sha}/blocks/${block}`;
  const rows = [
    ['Block', `${code(block)} ([code at ${sha.slice(0, 7)}](${tree}))`],
    ['Branch', code(branch)],
  ];
  if (page) {
    const daPath = page === '/' ? '/index' : page;
    const preview = `https://${branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}--${site}--${org}.aem.page${page}`;
    rows.push(['Page', `[${page}](https://da.live/edit#/${org}/${site}${daPath}) · [preview on this branch](${preview})`]);
  }
  if (reporter) rows.push(['Reported by', oneLine(reporter, 100)]);
  return [
    details.trim(),
    '',
    shotUrl ? `![Screenshot of the ${block} block](${shotUrl})` : null,
    shotUrl ? '' : null,
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    `<sub>Raised from Experience Workspace with Block Source.</sub>`,
    `<!-- block-source: block=${block} branch=${branch} sha=${sha} -->`,
  ].filter((l) => l !== null).join('\n');
}

async function limitReports(deps, callerKey) {
  const key = `report-${callerKey}-${Math.floor(deps.now() / WINDOW_MS)}`;
  const count = (await deps.state.get(key)) || 0;
  if (count >= REPORTS_PER_WINDOW) {
    throw new HttpError(429, 'too-many-reports', 'You raised several issues in the last few minutes. Wait a little and try again.', { retryAfter: 600 });
  }
  await deps.state.put(key, count + 1, WINDOW_MS / 1000 + 60);
}

/**
 * Opens a GitHub issue about a block, as the site's GitHub token, on behalf of an author.
 * The screenshot is stored by the broker and linked from the issue.
 */
async function raiseIssue(gh, deps, {
  org, site, block, branch, title, details, page, screenshot, reporter, callerKey,
}) {
  const cleanTitle = oneLine(title, 120);
  const cleanDetails = String(details || '').slice(0, 5000);
  if (cleanTitle.length < 3) throw new HttpError(400, 'missing-title', 'Give the issue a short title.');
  if (!cleanDetails.trim()) throw new HttpError(400, 'missing-details', 'Describe the problem.');
  const cleanPage = page && PAGE_PATH.test(page) ? page : null;
  const shot = screenshot ? decodeShot(screenshot) : null;
  await limitReports(deps, callerKey);

  let head;
  try {
    [head] = await gh.listCommits({ sha: branch, perPage: 1 });
  } catch (e) {
    if (e.code === 'not-found') throw new HttpError(404, 'unknown-branch', `The branch ${branch} does not exist.`);
    throw e;
  }
  if (!head) throw new HttpError(404, 'unknown-branch', `The branch ${branch} does not exist.`);

  let shotUrl = null;
  if (shot) {
    const base = publicBase(deps);
    if (base) {
      const id = `${crypto.randomBytes(16).toString('hex')}.${shot.ext}`;
      await deps.files.writeBuffer(shotPath(org, site, id), shot.buffer);
      shotUrl = `${base}/shot?${new URLSearchParams({ org, site, id })}`;
    }
  }

  const issue = {
    title: cleanTitle.toLowerCase().includes(block) ? cleanTitle : `${block}: ${cleanTitle}`,
    body: issueBody({
      details: cleanDetails, block, branch, sha: head.sha, gh, org, site, page: cleanPage, shotUrl, reporter,
    }),
    labels: [`block:${block}`],
  };
  let created;
  try {
    created = await gh.createIssue(issue);
  } catch (e) {
    if (e.code === 'unprocessable') {
      // The token's user may not be allowed to set labels; the block name in the title still links it.
      created = await gh.createIssue({ ...issue, labels: undefined });
    } else if (e.code === 'forbidden') {
      throw new HttpError(403, 'no-issue-permission', 'The site\'s GitHub token cannot open issues. A site administrator can give it the Issues: Read and write permission.');
    } else if (e.githubStatus === 410) {
      throw new HttpError(409, 'issues-disabled', 'Issues are turned off for this repository.');
    } else throw e;
  }
  await rememberIssue(gh, deps, block, created).catch((e) => deps.log.warn('report: could not remember issue', e.code));
  return {
    number: created.number, url: created.html_url, screenshot: Boolean(shotUrl), labelled: Boolean(created.labels && created.labels.length),
  };
}

/** Serves a stored screenshot. Public: GitHub loads it through its image proxy without credentials. */
async function serveShot(deps, { org, site, id }) {
  if (!SHOT_ID.test(String(id || ''))) throw new HttpError(404, 'not-found', 'Not found.');
  const buffer = await deps.files.readBuffer(shotPath(org, site, id));
  if (!buffer) throw new HttpError(404, 'not-found', 'Not found.');
  return {
    statusCode: 200,
    headers: {
      'Content-Type': SHOT_TYPES[id.split('.').pop()].mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
    body: buffer.toString('base64'),
  };
}

module.exports = {
  raiseIssue, serveShot, decodeShot, issueBody, publicBase, MAX_SHOT_BYTES,
};
