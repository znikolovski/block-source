'use strict';

const { HttpError, redact } = require('./http');

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'block-source-broker/0.1';

class GitHubError extends HttpError {
  constructor(status, code, message, extra = {}) {
    super(status >= 500 || code === 'rate-limited' ? 502 : status, code, message, extra);
    this.githubStatus = status;
    // Upstream failures may be served from stale cache.
    this.upstream = status >= 500 || code === 'rate-limited' || code === 'network';
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseExpiry(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  let tz = m[3] || 'Z';
  if (tz === 'UTC') tz = 'Z';
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const date = new Date(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function errorFor(status, headers, body) {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
  const message = (body && body.message) || '';
  if (status === 401) {
    return new GitHubError(401, 'unauthorized', 'The token is not valid, or it has expired. Create a new token.');
  }
  if ((status === 403 || status === 429) && (remaining === '0' || /rate limit/i.test(message))) {
    return new GitHubError(429, 'rate-limited', `Too many requests. Wait until ${resetAt || 'the reset time'}.`, { resetAt });
  }
  if (status === 403 && headers.get('x-github-sso')) {
    return new GitHubError(403, 'sso', 'Authorise the token for the organisation in GitHub (SAML single sign-on).', {
      ssoUrl: (headers.get('x-github-sso').match(/url=(\S+)/) || [])[1] || null,
    });
  }
  if (status === 403) {
    return new GitHubError(403, 'forbidden', 'The token does not have the permission this request needs.', {
      needs: headers.get('x-accepted-github-permissions') || null,
    });
  }
  if (status === 404) return new GitHubError(404, 'not-found', 'Not found.');
  if (status === 422) return new GitHubError(422, 'unprocessable', 'GitHub could not process the request.');
  return new GitHubError(status, 'unavailable', `GitHub returned ${status}.`);
}

/**
 * A GitHub client pinned to one repository and a fixed allow list of calls: reads, plus one
 * write (opening an issue). It is not a general proxy: anything outside the lists throws
 * before a request is made.
 */
function createGitHub({
  owner, repo, getToken, fetch = globalThis.fetch, log, secrets,
}) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner || '') || !/^[A-Za-z0-9._-]{1,100}$/.test(repo || '')) {
    throw new HttpError(500, 'bad-config', 'The stored repository is not valid.');
  }
  const base = `/repos/${owner}/${repo}`;
  const b = escapeRe(base);
  const ALLOW = [
    new RegExp(`^${b}$`),
    new RegExp(`^${b}/commits$`),
    new RegExp(`^${b}/commits/[0-9a-f]{7,40}$`),
    new RegExp(`^${b}/commits/[0-9a-f]{7,40}/(check-runs|status)$`),
    new RegExp(`^${b}/branches$`),
    new RegExp(`^${b}/compare/[^?#]+\\.\\.\\.[^?#]+$`),
    new RegExp(`^${b}/contents(/[^?#]*)?$`),
    new RegExp(`^${b}/pulls$`),
    new RegExp(`^${b}/issues$`),
    /^\/search\/issues$/,
    /^\/rate_limit$/,
  ];
  const WRITE_ALLOW = { POST: [new RegExp(`^${b}/issues$`)] };
  // Search is not scoped by its path, so every query must start with this repository.
  const searchScope = `repo:${owner}/${repo} `;

  async function request(path, {
    query, accept = 'application/vnd.github+json', raw = false, method = 'GET', body,
  } = {}) {
    const allowed = method === 'GET' ? ALLOW : (WRITE_ALLOW[method] || []);
    if (!allowed.some((re) => re.test(path)) || (path.includes('..') && !/\/compare\//.test(path))) {
      throw new HttpError(500, 'not-allowed', 'This GitHub call is not on the allow list.');
    }
    if (path === '/search/issues' && !(query && String(query.q).startsWith(searchScope) && !/\brepo:|\borg:|\buser:/i.test(String(query.q).slice(searchScope.length)))) {
      throw new HttpError(500, 'not-allowed', 'Issue search must stay in this repository.');
    }
    const url = new URL(`${API}${path}`);
    Object.entries(query || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    const token = await getToken();
    let res;
    try {
      const headers = {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
      };
      if (body) headers['Content-Type'] = 'application/json';
      res = await fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      log?.warn('github network error', path, redact(e, secrets));
      throw new GitHubError(503, 'network', 'GitHub could not be reached.');
    }
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        // ignore
      }
      log?.info('github error', res.status, path, redact(body && body.message, secrets));
      throw errorFor(res.status, res.headers, body);
    }
    const data = raw ? await res.text() : await res.json();
    return { data, headers: res.headers, status: res.status };
  }

  async function orNull(promise) {
    try {
      return await promise;
    } catch (e) {
      if (e.code === 'not-found') return null;
      throw e;
    }
  }

  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  return {
    owner,
    repo,
    request,
    async getRepo() {
      return request(base);
    },
    async rateLimit() {
      return request('/rate_limit');
    },
    async listCommits({ sha, path, perPage = 20, since } = {}) {
      return (await request(`${base}/commits`, {
        query: {
          sha, path, per_page: perPage, since,
        },
      })).data;
    },
    async getCommit(sha) {
      return (await request(`${base}/commits/${sha}`)).data;
    },
    async listBranches({ maxPages = 5 } = {}) {
      const all = [];
      for (let page = 1; page <= maxPages; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const { data } = await request(`${base}/branches`, { query: { per_page: 100, page } });
        all.push(...data);
        if (data.length < 100) return { branches: all, truncated: false };
      }
      return { branches: all, truncated: true };
    },
    async compare(baseRef, headRef) {
      return (await request(`${base}/compare/${enc(baseRef)}...${enc(headRef)}`, { query: { per_page: 250 } })).data;
    },
    async getContent(path, ref) {
      const res = await orNull(request(`${base}/contents/${enc(path)}`, { query: { ref } }));
      return res ? res.data : null;
    },
    async getRaw(path, ref) {
      const res = await orNull(request(`${base}/contents/${enc(path)}`, {
        query: { ref }, accept: 'application/vnd.github.raw+json', raw: true,
      }));
      return res ? res.data : null;
    },
    async listOpenPulls() {
      return (await request(`${base}/pulls`, { query: { state: 'open', per_page: 100 } })).data;
    },
    async listIssues({ labels, perPage = 50 } = {}) {
      return (await request(`${base}/issues`, { query: { state: 'open', labels, per_page: perPage } })).data;
    },
    async searchIssues(terms, { perPage = 50 } = {}) {
      return (await request('/search/issues', { query: { q: `${searchScope}${terms}`, per_page: perPage } })).data;
    },
    async createIssue({ title, body, labels }) {
      return (await request(`${base}/issues`, { method: 'POST', body: { title, body, labels } })).data;
    },
    async probe(path, query) {
      try {
        await request(path, { query });
        return 'granted';
      } catch (e) {
        if (e.code === 'forbidden' || e.code === 'not-found') return 'missing';
        throw e;
      }
    },
    base,
  };
}

module.exports = {
  createGitHub, GitHubError, parseExpiry, errorFor, API, API_VERSION, USER_AGENT,
};
