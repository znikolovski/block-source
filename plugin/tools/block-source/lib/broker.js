export class BrokerError extends Error {
  constructor(status, code, message, body = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function validBrokerUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.href.replace(/\/+$/, '');
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return u.href.replace(/\/+$/, '');
  } catch {
    // invalid
  }
  return null;
}

/** Client for the broker. Every call carries the author's DA token; the broker checks it with DA. */
export function createBroker({
  baseUrl, org, site, getToken, fetchFn = (...a) => fetch(...a), ttlMs = 60000, now = () => Date.now(),
}) {
  const cache = new Map();

  async function request(method, path, { query = {}, body } = {}) {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set('org', org);
    url.searchParams.set('site', site);
    Object.entries(query).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, v));
    const headers = { Authorization: `Bearer ${getToken()}` };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetchFn(url.toString(), {
        method, headers, body: body ? JSON.stringify({ org, site, ...body }) : undefined, credentials: 'omit',
      });
    } catch {
      throw new BrokerError(0, 'network', 'The Block Source service could not be reached.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // empty body
    }
    if (!res.ok) {
      throw new BrokerError(res.status, (data && data.error) || 'error', (data && data.message) || `The Block Source service returned ${res.status}.`, data || {});
    }
    return data;
  }

  return {
    async get(path, query = {}, { fresh = false } = {}) {
      const key = `${path}?${new URLSearchParams(query)}`;
      const hit = cache.get(key);
      if (!fresh && hit && now() - hit.at < ttlMs) return hit.promise;
      const promise = request('GET', path, { query });
      cache.set(key, { at: now(), promise });
      promise.catch(() => cache.delete(key));
      return promise;
    },
    post(path, body = {}) {
      return request('POST', path, { body });
    },
    del(path) {
      return request('DELETE', path);
    },
    invalidate() {
      cache.clear();
    },
    telemetry(event, data = {}) {
      request('POST', '/telemetry', { body: { event, ...data } }).catch(() => {});
    },
  };
}
