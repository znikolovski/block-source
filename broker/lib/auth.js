'use strict';

const { HttpError } = require('./http');
const { sha256 } = require('./crypto');

const ACL_TTL = 60;

function decodeIdentity(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { id: payload.user_id || payload.sub || null, clientId: payload.client_id || null };
  } catch {
    return { id: null, clientId: null };
  }
}

/** Parses `x-da-actions: /org/site=read,write` into a set of actions. */
function parseDaActions(header) {
  if (!header) return new Set();
  const value = String(header).split('=').pop();
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

function parseSiteConfig(json) {
  const kv = {};
  if (!json || typeof json !== 'object') json = {};
  const sheets = json[':type'] === 'multi-sheet'
    ? (json[':names'] || []).map((n) => [n, (json[n] && json[n].data) || []])
    : [['data', json.data || []]];
  sheets.forEach(([name, rows]) => {
    rows.forEach((row) => {
      if (row.key !== undefined && row.key !== null && row.key !== '') {
        kv[String(row.key).trim()] = String(row.value ?? '').trim();
      } else if (name === 'blocksource' && row.org && row.repo) {
        kv['github.owner'] = kv['github.owner'] || String(row.org).trim();
        kv['github.repo'] = kv['github.repo'] || String(row.repo).trim();
      }
    });
  });
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const external = {};
  list(kv['blocksource.external']).forEach((pair) => {
    const [name, ...rest] = pair.split('=');
    if (name && rest.length) external[name.trim()] = rest.join('=').trim();
  });
  return {
    owner: kv['github.owner'] || null,
    repo: kv['github.repo'] || null,
    broker: kv['blocksource.broker'] || null,
    protectedBranches: list(kv['blocksource.protected']),
    defaultBranch: kv['blocksource.default-branch'] || null,
    external,
  };
}

async function daFetch(deps, path, token) {
  try {
    return await deps.fetch(`${deps.config.daAdminUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new HttpError(503, 'da-unavailable', 'Experience Workspace could not be reached to check access.');
  }
}

/**
 * The broker keeps no user list. It asks DA whether the caller can read the site,
 * and whether the caller can write the site configuration (administrator).
 */
async function checkCaller({
  token, org, site, needAdmin = false,
}, deps) {
  if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in to Experience Workspace.');
  const key = `acl-${sha256(token).slice(0, 32)}-${org}-${site}`;
  let acl = await deps.state.get(key);
  if (!acl) {
    const list = await daFetch(deps, `/list/${org}/${site}`, token);
    if (list.status === 401) throw new HttpError(401, 'unauthenticated', 'Your session has expired. Reload Experience Workspace.');
    const read = list.ok;
    let admin = false;
    if (read) {
      const cfg = await daFetch(deps, `/config/${org}/${site}/`, token);
      admin = cfg.ok && parseDaActions(cfg.headers.get('x-da-actions')).has('write');
    }
    acl = { read, admin };
    await deps.state.put(key, acl, ACL_TTL);
  }
  if (!acl.read) throw new HttpError(403, 'no-access', 'You do not have access to this site.');
  if (needAdmin && !acl.admin) throw new HttpError(403, 'not-admin', 'Only site administrators can change this setting.');
  return { ...acl, identity: decodeIdentity(token), callerKey: sha256(token).slice(0, 24) };
}

async function readSiteConfig({ token, org, site }, deps) {
  const res = await daFetch(deps, `/config/${org}/${site}/`, token);
  if (!res.ok) return parseSiteConfig(null);
  try {
    return parseSiteConfig(await res.json());
  } catch {
    return parseSiteConfig(null);
  }
}

/** Best-effort profile lookup for the audit log. */
async function imsProfile(token, deps) {
  try {
    const res = await deps.fetch(`${deps.config.imsUrl}/ims/profile/v1`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return {};
    const p = await res.json();
    return { email: p.email || null, name: p.displayName || p.name || null };
  } catch {
    return {};
  }
}

module.exports = {
  checkCaller, readSiteConfig, parseSiteConfig, parseDaActions, decodeIdentity, imsProfile,
};
