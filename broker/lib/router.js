'use strict';

const {
  HttpError, respond, parseRequest, corsHeaders, isAllowedOrigin, bearer, createLogger, redact,
} = require('./http');
const { initStores } = require('./storage');
const { createCache } = require('./cache');
const { checkCaller, readSiteConfig, imsProfile } = require('./auth');
const { rateLimit } = require('./util');
const {
  loadRecord, saveRecord, deleteRecord, sealToken, appendAudit, readAudit, githubFor, publicStatus, tokenType,
} = require('./token-store');
const { createGitHub } = require('./github');
const { verifySiteRepo } = require('./site-repo');
const { validateCredential } = require('./validate');
const {
  assertName, assertRef, assertOrg,
} = require('./blocks');
const { blockHistory } = require('./history');
const { deployedCheck } = require('./deployed');
const { newerVersions, buildIndex } = require('./branches');
const { blockSummary } = require('./summary');
const { compatibility } = require('./compat');
const { blockModule } = require('./module');
const { scanUsage } = require('./usage');
const { recordEvent, insights } = require('./telemetry');
const { blockInsights } = require('./insights');
const { raiseIssue, serveShot } = require('./report');

const STATUS_TTL = 60;

function readConfig(params) {
  return {
    encryptionKey: params.ENCRYPTION_KEY,
    daAdminUrl: String(params.DA_ADMIN_URL || 'https://admin.da.live').replace(/\/+$/, ''),
    imsUrl: String(params.IMS_URL || 'https://ims-na1.adobelogin.com').replace(/\/+$/, ''),
    rateLimit: Number(params.RATE_LIMIT_PER_MINUTE || 60),
    maxBranches: Number(params.MAX_BRANCHES || 100),
    activityDays: Number(params.BRANCH_ACTIVITY_DAYS || 90),
    imsClientId: params.IMS_CLIENT_ID || null,
    imsClientSecret: params.IMS_CLIENT_SECRET || null,
    imsScopes: params.IMS_SCOPES || 'openid,AdobeID,read_organizations',
    logLevel: params.LOG_LEVEL || 'info',
    publicUrl: params.PUBLIC_URL || null,
  };
}

async function buildDeps(params, overrides = {}) {
  const config = { ...readConfig(params), ...(overrides.config || {}) };
  const secrets = new Set();
  [config.encryptionKey, config.imsClientSecret].forEach((s) => s && secrets.add(s));
  const now = overrides.now || (() => Date.now());
  const log = overrides.log || createLogger(console, secrets, config.logLevel);
  const stores = overrides.state && overrides.files
    ? { state: overrides.state, files: overrides.files }
    : await initStores();
  return {
    config,
    secrets,
    now,
    log,
    fetch: overrides.fetch || globalThis.fetch,
    state: stores.state,
    files: stores.files,
    cache: createCache(stores.state, { now, log }),
  };
}

const SETTING_REF = /^[A-Za-z0-9._/*-]{1,200}$/;

function sanitizeSettings(input = {}) {
  const out = {};
  if (Array.isArray(input.protectedBranches)) {
    out.protectedBranches = input.protectedBranches.map(String).map((s) => s.trim()).filter((s) => SETTING_REF.test(s)).slice(0, 50);
  }
  if (input.external && typeof input.external === 'object') {
    out.external = {};
    Object.entries(input.external).slice(0, 100).forEach(([k, v]) => {
      if (/^[a-z0-9_-]{1,64}$/i.test(k) && typeof v === 'string') out.external[k.toLowerCase()] = v.slice(0, 300);
    });
  }
  if (typeof input.samplePathPattern === 'string' && /^\/[A-Za-z0-9._/{}-]{0,200}$/.test(input.samplePathPattern)) {
    out.samplePathPattern = input.samplePathPattern;
  }
  if (typeof input.defaultBranch === 'string' && SETTING_REF.test(input.defaultBranch) && !input.defaultBranch.includes('*')) {
    out.defaultBranch = input.defaultBranch;
  }
  return out;
}

function settingsFromConfig(siteConfig) {
  const out = {};
  if (siteConfig.protectedBranches.length) out.protectedBranches = siteConfig.protectedBranches;
  if (Object.keys(siteConfig.external).length) out.external = siteConfig.external;
  if (siteConfig.defaultBranch) out.defaultBranch = siteConfig.defaultBranch;
  return sanitizeSettings(out);
}

function requireRecord(record) {
  if (!record) throw new HttpError(409, 'not-configured', 'Block Source is not set up for this site yet.');
  return record;
}

const blockArgs = (q) => ({ block: assertName(q.block), ref: assertRef(q.ref || 'main') });

async function liveStatus({
  org, site, record, gh, deps,
}) {
  if (!record) return null;
  return deps.cache.value(`tokstat-${org}-${site}`, STATUS_TTL, async () => {
    const v = await validateCredential(gh, { now: deps.now() });
    return { ok: v.ok, error: v.error, status: v.status };
  }, { allowStale: false });
}

async function audit(deps, org, site, caller, profile, action, extra = {}) {
  const entry = {
    action,
    at: new Date(deps.now()).toISOString(),
    actor: { id: caller.identity.id, ...profile },
    ...extra,
  };
  await appendAudit(deps.files, org, site, entry);
  deps.log.info(JSON.stringify({ telemetry: `token-${action}`, org, site, actor: entry.actor.id }));
}

async function setToken({
  q, org, site, caller, record, deps, token,
}) {
  const siteConfig = await readSiteConfig({ token, org, site }, deps);
  const owner = String(q.owner || siteConfig.owner || (record && record.owner) || '').trim();
  const repo = String(q.repo || siteConfig.repo || (record && record.repo) || '').trim();
  if (!owner || !repo) {
    throw new HttpError(400, 'missing-repo', 'Enter the GitHub owner and repository, or set github.owner and github.repo in the site config.');
  }
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (siteConfig.owner && siteConfig.repo && !(same(owner, siteConfig.owner) && same(repo, siteConfig.repo))) {
    throw new HttpError(400, 'repo-mismatch', `The site config says this site's code is in ${siteConfig.owner}/${siteConfig.repo}, not ${owner}/${repo}. Use that repository, or change github.owner and github.repo in the site config.`, {
      expected: `${siteConfig.owner}/${siteConfig.repo}`,
    });
  }
  const next = {
    v: 1,
    org,
    site,
    owner,
    repo,
    settings: {
      ...settingsFromConfig(siteConfig), ...((record && record.settings) || {}), ...sanitizeSettings(q.settings),
    },
  };
  const secret = String(q.token || '').trim();
  if (!secret) throw new HttpError(400, 'missing-token', 'Paste a GitHub token.');
  deps.secrets.add(secret);
  const gh = createGitHub({
    owner, repo, fetch: deps.fetch, log: deps.log, secrets: deps.secrets, getToken: async () => secret,
  });
  next.secret = sealToken(secret, deps.config, org, site);
  const type = tokenType(secret);
  const last4 = secret.slice(-4);
  // Validate before replacing the stored credential, so rotation has no downtime.
  const v = await validateCredential(gh, { now: deps.now() });
  if (!v.ok) {
    const message = v.error.code === 'no-repo-access'
      ? `The token cannot see ${owner}/${repo}. It may be for a different repository. Create a token with access to ${owner}/${repo}, or check the owner and repository.`
      : v.error.message;
    throw new HttpError(422, v.error.code, message, { resetAt: v.error.resetAt, ssoUrl: v.error.ssoUrl });
  }
  const siteCheck = await verifySiteRepo(gh, deps, { org, site, branch: v.status.defaultBranch });
  if (siteCheck.state === 'mismatch') {
    throw new HttpError(422, 'wrong-repo', `${owner}/${repo} is not the code for this site: the code served at ${siteCheck.origin} is different. Check the owner and repository.`, {
      origin: siteCheck.origin,
    });
  }
  const profile = await imsProfile(token, deps);
  next.meta = {
    ...v.status,
    type,
    last4,
    siteCheck,
    configuredBy: { id: caller.identity.id, ...profile },
    configuredAt: new Date(deps.now()).toISOString(),
  };
  await saveRecord(deps.files, next);
  await deps.state.delete(`tokstat-${org}-${site}`);
  await audit(deps, org, site, caller, profile, record ? 'rotate' : 'set', {
    last4, expiresAt: next.meta.expiresAt,
  });
  return publicStatus(next);
}

const ROUTES = {
  'GET /status': {
    handler: async ({ caller, record }) => ({
      configured: Boolean(record),
      isAdmin: caller.admin,
      owner: record ? record.owner : null,
      repo: record ? record.repo : null,
      expiresSoon: Boolean(record && record.meta && record.meta.expiresSoon),
    }),
  },
  'GET /history': {
    needsRecord: true,
    handler: ({ q, gh, deps, record }) => blockHistory(gh, deps, { ...blockArgs(q), record }),
  },
  'GET /deployed': {
    needsRecord: true,
    handler: ({
      q, gh, deps, org, site,
    }) => deployedCheck(gh, deps, { ...blockArgs(q), org, site }),
  },
  'GET /branches': {
    needsRecord: true,
    handler: ({
      q, gh, deps, org, site, record,
    }) => newerVersions(gh, deps, {
      ...blockArgs(q), org, site, record, fresh: q.fresh === '1',
    }),
  },
  'GET /summary': {
    needsRecord: true,
    handler: ({
      q, gh, deps, org, site, record,
    }) => blockSummary(gh, deps, {
      ...blockArgs(q), org, site, record,
    }),
  },
  'GET /insights': {
    needsRecord: true,
    handler: ({
      q, gh, deps, org, site, record,
    }) => blockInsights(gh, deps, {
      ...blockArgs(q), org, site, record,
    }),
  },
  'GET /compat': {
    needsRecord: true,
    handler: ({
      q, gh, deps, org, site, record,
    }) => compatibility(gh, deps, {
      ...blockArgs(q), branch: assertRef(q.branch, 'branch'), org, site, record,
    }),
  },
  'GET /module': {
    needsRecord: true,
    handler: ({
      q, gh, deps, org, site,
    }) => blockModule(gh, deps, {
      block: assertName(q.block), branch: assertRef(q.branch, 'branch'), org, site,
    }),
  },
  'POST /issues': {
    needsRecord: true,
    handler: async ({
      q, gh, deps, org, site, caller, token,
    }) => {
      const profile = await imsProfile(token, deps);
      return raiseIssue(gh, deps, {
        org,
        site,
        block: assertName(q.block),
        branch: assertRef(q.branch, 'branch'),
        title: q.title,
        details: q.details,
        page: typeof q.page === 'string' ? q.page : null,
        screenshot: q.screenshot || null,
        reporter: profile.name || null,
        callerKey: caller.callerKey,
      });
    },
  },
  'GET /shot': {
    public: true,
    handler: ({ q, deps, org, site }) => serveShot(deps, { org, site, id: q.id }),
  },
  'POST /telemetry': {
    handler: ({
      q, deps, org, site,
    }) => recordEvent(deps, {
      org,
      site,
      event: q.event,
      block: q.block ? assertName(q.block) : null,
      branch: q.branch ? assertRef(q.branch, 'branch') : null,
      verdict: q.verdict,
      durationMs: Number(q.durationMs),
    }),
  },
  'GET /admin/token': {
    admin: true,
    handler: async (args) => {
      const {
        org, site, record, deps, token,
      } = args;
      const [live, auditLog, stats, siteConfig] = await Promise.all([
        liveStatus(args).catch((e) => ({ ok: false, error: { code: e.code, message: e.message } })),
        readAudit(deps.files, org, site),
        insights(deps, { org, site }),
        readSiteConfig({ token, org, site }, deps),
      ]);
      return {
        ...publicStatus(record),
        live,
        audit: auditLog.slice(0, 20),
        insights: stats,
        siteConfig: { owner: siteConfig.owner, repo: siteConfig.repo },
      };
    },
  },
  'POST /admin/token': { admin: true, handler: setToken },
  'POST /admin/token/validate': {
    admin: true,
    needsRecord: true,
    handler: async ({
      org, site, record, gh, deps,
    }) => {
      await deps.state.delete(`tokstat-${org}-${site}`);
      const v = await validateCredential(gh, { now: deps.now() });
      if (v.ok) {
        const next = { ...record, meta: { ...record.meta, ...v.status } };
        await saveRecord(deps.files, next);
        return { ...publicStatus(next), live: v };
      }
      return { ...publicStatus(record), live: v };
    },
  },
  'DELETE /admin/token': {
    admin: true,
    needsRecord: true,
    handler: async ({
      org, site, record, caller, deps, token,
    }) => {
      await deleteRecord(deps.files, org, site);
      await deps.state.delete(`tokstat-${org}-${site}`);
      await audit(deps, org, site, caller, await imsProfile(token, deps), 'remove', {
        last4: record.meta && record.meta.last4,
      });
      return { configured: false };
    },
  },
  'POST /admin/settings': {
    admin: true,
    needsRecord: true,
    handler: async ({
      q, record, deps, token, org, site,
    }) => {
      const siteConfig = await readSiteConfig({ token, org, site }, deps);
      const next = {
        ...record,
        settings: { ...settingsFromConfig(siteConfig), ...(record.settings || {}), ...sanitizeSettings(q.settings) },
      };
      await saveRecord(deps.files, next);
      return publicStatus(next);
    },
  },
  'POST /admin/usage-scan': {
    admin: true,
    handler: ({
      org, site, deps, token,
    }) => scanUsage(deps, {
      org, site, token, budgetMs: 45000,
    }),
  },
  'POST /admin/index': {
    admin: true,
    needsRecord: true,
    handler: async ({
      org, site, record, gh, deps,
    }) => {
      const index = await buildIndex(gh, deps, { org, site, record });
      return { generatedAt: index.generatedAt, blocks: Object.keys(index.blocks).length };
    },
  },
};

function errorResponse(e, deps, cors) {
  const status = e instanceof HttpError ? e.status : 500;
  const body = {
    error: e instanceof HttpError ? e.code : 'internal',
    message: e instanceof HttpError ? redact(e.message, deps.secrets) : 'Unexpected error.',
  };
  if (e && e.extra) {
    ['resetAt', 'ssoUrl', 'retryAfter', 'needs'].forEach((k) => {
      if (e.extra[k]) body[k] = e.extra[k];
    });
  }
  if (status >= 500) deps.log.error('request failed', e && e.stack ? e.stack : e);
  else deps.log.info('request rejected', status, body.error);
  const headers = { ...cors };
  if (body.retryAfter) headers['Retry-After'] = String(body.retryAfter);
  return respond(status, body, headers);
}

async function handle(params, deps) {
  let cors = {};
  try {
    const req = parseRequest(params);
    const q = { ...req.query, ...req.body };
    const origin = req.headers.origin;
    cors = corsHeaders(origin, { org: q.org, site: q.site });
    if (req.method === 'OPTIONS') return { statusCode: 204, headers: cors };
    if (origin && !isAllowedOrigin(origin, { org: q.org, site: q.site })) {
      throw new HttpError(403, 'origin', 'This origin may not call the broker.');
    }
    const route = ROUTES[`${req.method} ${req.path}`];
    if (!route) throw new HttpError(404, 'not-found', 'Unknown endpoint.');

    const org = assertOrg(q.org, 'org');
    const site = assertOrg(q.site, 'site');
    if (route.public) return await route.handler({ q, org, site, deps });
    const token = bearer(req.headers);
    const caller = await checkCaller({
      token, org, site, needAdmin: Boolean(route.admin),
    }, deps);
    await rateLimit(deps.state, caller.callerKey, deps.config.rateLimit, deps.now());

    const record = await loadRecord(deps.files, org, site);
    if (route.needsRecord) requireRecord(record);
    const gh = record ? githubFor(record, deps) : null;
    const result = await route.handler({
      req, q, org, site, caller, record, gh, deps, token,
    });
    return respond(200, result, cors);
  } catch (e) {
    return errorResponse(e, deps, cors);
  }
}

module.exports = {
  handle, buildDeps, readConfig, sanitizeSettings, ROUTES,
};
