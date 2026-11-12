'use strict';

const { HttpError } = require('./http');

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rateLimit(state, callerKey, limit, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  const key = `rl-${callerKey}-${minute}`;
  const count = (await state.get(key)) || 0;
  if (count >= limit) {
    throw new HttpError(429, 'too-many-requests', 'Too many requests. Wait a minute and try again.', {
      retryAfter: 60 - Math.floor((now % 60000) / 1000),
    });
  }
  await state.put(key, count + 1, 120);
}

module.exports = { pool, rateLimit };
