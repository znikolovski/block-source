'use strict';

const { parseExpiry } = require('./github');

const EXPIRY_WARNING_DAYS = 14;

const MESSAGES = {
  unauthorized: 'The token is not valid, or it has expired. Create a new token.',
  sso: 'Authorise the token for the organisation in GitHub.',
  'no-repo-access': 'The token has no access to this repository. Check the repository selection.',
  'rate-limited': 'Too many requests. Wait for the reset time shown.',
  forbidden: 'The token is missing a required permission (Contents: Read-only).',
  network: 'GitHub could not be reached. Try again.',
  unavailable: 'GitHub is not available right now. Try again.',
};

function validationError(e) {
  const code = e.code === 'not-found' ? 'no-repo-access' : (e.code || 'unavailable');
  return {
    code,
    message: MESSAGES[code] || e.message,
    resetAt: e.extra && e.extra.resetAt,
    ssoUrl: e.extra && e.extra.ssoUrl,
  };
}

/**
 * Proves the credential with real calls and reports exactly what is granted:
 * GET /repos/{o}/{r} (access, expiry header), GET /rate_limit (live, quota),
 * plus read probes for the optional permissions.
 */
async function validateCredential(gh, { now = Date.now() } = {}) {
  try {
    const repo = await gh.getRepo();
    const rl = await gh.rateLimit();
    const expiresAt = parseExpiry(repo.headers.get('github-authentication-token-expiration'));
    const scopes = repo.headers.get('x-oauth-scopes');

    let contents = 'missing';
    let sha = null;
    try {
      const commits = await gh.listCommits({ perPage: 1 });
      contents = 'granted';
      sha = commits[0] && commits[0].sha;
    } catch (e) {
      if (!['forbidden', 'not-found'].includes(e.code)) throw e;
    }
    const permissions = {
      metadata: 'granted',
      contents,
      pull_requests: await gh.probe(`${gh.base}/pulls`, { per_page: 1 }),
      issues: await gh.probe(`${gh.base}/issues`, { per_page: 1 }),
      checks: sha ? await gh.probe(`${gh.base}/commits/${sha}/check-runs`, { per_page: 1 }) : 'unknown',
      statuses: sha ? await gh.probe(`${gh.base}/commits/${sha}/status`) : 'unknown',
    };
    const core = (rl.data.resources && rl.data.resources.core) || rl.data.rate || {};
    const expiresSoon = expiresAt
      ? Date.parse(expiresAt) - now < EXPIRY_WARNING_DAYS * 24 * 3600 * 1000
      : false;
    return {
      ok: contents === 'granted',
      error: contents === 'granted' ? null : validationError({ code: 'forbidden' }),
      status: {
        repoAccess: true,
        private: Boolean(repo.data.private),
        defaultBranch: repo.data.default_branch,
        expiresAt,
        expiresSoon,
        scopes: scopes || null,
        permissions,
        missingRequired: ['contents', 'metadata'].filter((p) => permissions[p] !== 'granted'),
        missingOptional: ['pull_requests', 'issues', 'checks', 'statuses'].filter((p) => permissions[p] === 'missing'),
        rateLimit: {
          limit: core.limit ?? null,
          remaining: core.remaining ?? null,
          resetAt: core.reset ? new Date(core.reset * 1000).toISOString() : null,
        },
        validatedAt: new Date(now).toISOString(),
      },
    };
  } catch (e) {
    return { ok: false, error: validationError(e), status: null };
  }
}

module.exports = { validateCredential, validationError, MESSAGES };
