'use strict';

const { buildDeps } = require('../../lib/router');
const { listRecords } = require('../../lib/token-store');
const { scanUsage, serviceToken } = require('../../lib/usage');

/** Scheduled nightly: counts block usage across each configured site using a DA service token. */
async function main(params) {
  const deps = await buildDeps(params);
  const token = await serviceToken(deps);
  if (!token) return { ok: true, skipped: 'IMS_CLIENT_ID and IMS_CLIENT_SECRET are not configured' };
  const records = await listRecords(deps.files);
  const results = [];
  for (const record of records) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const usage = await scanUsage(deps, {
        org: record.org, site: record.site, token, budgetMs: 120000,
      });
      results.push({ site: `${record.org}/${record.site}`, ok: true, pages: usage.pages });
    } catch (e) {
      deps.log.warn('usage scan failed', record.org, record.site, e.message);
      results.push({ site: `${record.org}/${record.site}`, ok: false });
    }
  }
  return { ok: true, results };
}

exports.main = main;
