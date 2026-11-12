'use strict';

const { buildDeps } = require('../../lib/router');
const { listRecords, githubFor } = require('../../lib/token-store');
const { buildIndex } = require('../../lib/branches');

/** Scheduled every 10 minutes: refreshes the block -> branches index for every configured site. */
async function main(params) {
  const deps = await buildDeps(params);
  const records = await listRecords(deps.files);
  const results = [];
  for (const record of records) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const index = await buildIndex(githubFor(record, deps), deps, { org: record.org, site: record.site, record });
      results.push({ site: `${record.org}/${record.site}`, ok: true, blocks: Object.keys(index.blocks).length });
    } catch (e) {
      deps.log.warn('index failed', record.org, record.site, e.code || e.message);
      results.push({ site: `${record.org}/${record.site}`, ok: false, error: e.code || 'error' });
    }
  }
  return { ok: true, results };
}

exports.main = main;
