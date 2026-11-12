'use strict';

const { HttpError } = require('./http');

const EVENTS = new Set(['panel-opened', 'compat-checked', 'preview-applied', 'preview-reverted']);
const VERDICTS = new Set(['safe', 'blocked', 'unknown', 'needs-dry-run', 'error', undefined]);
const docPath = (org, site) => `telemetry/${org}/${site}.json`;

/**
 * Records plugin events without personal content: event, block, branch, verdict, duration.
 * Counters per block feed the "often blocked" insight for developers.
 */
async function recordEvent(deps, {
  org, site, event, block, branch, verdict, durationMs,
}) {
  if (!EVENTS.has(event)) throw new HttpError(400, 'bad-request', 'Unknown telemetry event.');
  if (!VERDICTS.has(verdict)) throw new HttpError(400, 'bad-request', 'Unknown verdict.');
  const entry = {
    telemetry: event,
    org,
    site,
    block: block || null,
    branch: branch || null,
    verdict: verdict || null,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
  };
  deps.log.info(JSON.stringify(entry));
  const doc = (await deps.files.readJson(docPath(org, site))) || { events: {}, blocks: {} };
  doc.events[event] = (doc.events[event] || 0) + 1;
  if (block) {
    const b = doc.blocks[block] || {
      opened: 0, checks: 0, blocked: 0, applied: 0, reverted: 0,
    };
    if (event === 'panel-opened') b.opened += 1;
    if (event === 'compat-checked') {
      b.checks += 1;
      if (verdict === 'blocked') b.blocked += 1;
    }
    if (event === 'preview-applied') b.applied += 1;
    if (event === 'preview-reverted') b.reverted += 1;
    doc.blocks[block] = b;
  }
  doc.updatedAt = new Date(deps.now()).toISOString();
  await deps.files.writeJson(docPath(org, site), doc);
  return { ok: true };
}

async function insights(deps, { org, site }) {
  const doc = (await deps.files.readJson(docPath(org, site))) || { events: {}, blocks: {} };
  const oftenBlocked = Object.entries(doc.blocks)
    .filter(([, b]) => b.blocked > 0)
    .map(([block, b]) => ({ block, blocked: b.blocked, checks: b.checks }))
    .sort((a, b) => b.blocked - a.blocked)
    .slice(0, 10);
  return { events: doc.events, oftenBlocked, updatedAt: doc.updatedAt || null };
}

module.exports = { recordEvent, insights, EVENTS };
