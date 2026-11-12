const HOST_RE = /^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.(aem\.page|aem\.live|preview\.da\.live|stage-preview\.da\.live)$/i;
export const LOCAL_REF_KEY = 'block-source:local-ref';

/** {ref}--{site}--{org}.aem.page|live, or the DA preview proxy that serves library plugins: {ref}--{site}--{org}.preview.da.live */
export function parseHost(hostname) {
  const m = HOST_RE.exec(hostname || '');
  if (!m) return null;
  return {
    ref: m[1].toLowerCase(), site: m[2].toLowerCase(), org: m[3].toLowerCase(), tier: m[4].toLowerCase().replace(/^aem\./, '').replace(/\.da\.live$/, ''),
  };
}

export function isLocal(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * The ref the author is working on. Precedence:
 * 1. the plugin hostname ({ref}--site--org), which is how DA serves tools for a branch
 * 2. ?ref= on the plugin URL
 * 3. on localhost, the localStorage override (the local server does not know its branch)
 * 4. main
 */
export function resolveRef(location, storage) {
  const host = parseHost(location.hostname);
  if (host) return { ref: host.ref, source: 'hostname' };
  const query = new URLSearchParams(location.search || '').get('ref');
  if (query && /^[A-Za-z0-9._/-]{1,200}$/.test(query)) return { ref: query, source: 'query' };
  if (isLocal(location.hostname)) {
    let local = null;
    try {
      local = storage && storage.getItem(LOCAL_REF_KEY);
    } catch {
      // storage blocked
    }
    if (local) return { ref: local, source: 'local-override' };
  }
  return { ref: 'main', source: 'default' };
}

/** A branch can be previewed only if it is a valid hostname label: {branch}--{site}--{org} within 63 characters. */
export function previewOrigin(branch, site, org) {
  if (!/^[a-z0-9-]+$/i.test(branch || '')) return null;
  const label = `${branch}--${site}--${org}`.toLowerCase();
  if (label.length > 63) return null;
  return `https://${label}.aem.page`;
}

/** Site and org: from the SDK context when available, else from the plugin hostname. */
export function siteContext(context = {}, location = window.location) {
  const host = parseHost(location.hostname) || {};
  const org = (context.org || host.org || '').toLowerCase();
  const site = (context.repo || context.site || host.site || '').toLowerCase();
  let path = context.path || new URLSearchParams(location.search || '').get('path') || '/';
  path = path.replace(/\.html$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return { org, site, path };
}
