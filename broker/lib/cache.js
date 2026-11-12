'use strict';

const STALE_TTL = 24 * 3600;

/**
 * Read-through cache over the state store.
 * Entries are kept for `staleTtl` but are fresh only for `ttl`. When the loader fails
 * with an upstream error (GitHub down or rate limited) a stale entry is served instead,
 * with its age, so the plugin can degrade to "cached data" rather than an error wall.
 */
function createCache(state, { now = () => Date.now(), log } = {}) {
  async function wrap(key, ttl, loader, { staleTtl = STALE_TTL, allowStale = true, force = false } = {}) {
    let entry = null;
    try {
      entry = await state.get(key);
    } catch (e) {
      log?.warn('cache read failed', key, e);
    }
    const age = entry ? Math.round((now() - entry.at) / 1000) : null;
    if (entry && age < ttl && !force) return { value: entry.v, cachedAt: entry.at, stale: false };
    try {
      const value = await loader();
      try {
        await state.put(key, { v: value, at: now() }, Math.max(ttl, staleTtl));
      } catch (e) {
        log?.warn('cache write failed', key, e);
      }
      return { value, cachedAt: now(), stale: false };
    } catch (e) {
      if (allowStale && entry && e && e.upstream) {
        return {
          value: entry.v, cachedAt: entry.at, stale: true, ageSeconds: age, error: e.code,
        };
      }
      throw e;
    }
  }

  async function value(key, ttl, loader, opts) {
    return (await wrap(key, ttl, loader, opts)).value;
  }

  return { wrap, value };
}

module.exports = { createCache };
