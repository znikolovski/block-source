'use strict';

const { seal, open, loadMasterKey } = require('./crypto');
const { HttpError } = require('./http');
const { createGitHub } = require('./github');

const recordPath = (org, site) => `tokens/${org}/${site}.json`;
const auditPath = (org, site) => `audit/${org}/${site}.json`;
const aadFor = (org, site) => `block-source:${org}/${site}`;
const AUDIT_MAX = 200;

function tokenType(token) {
  if (/^github_pat_/.test(token)) return 'fine-grained';
  if (/^ghp_/.test(token)) return 'classic';
  return 'unknown';
}

async function loadRecord(files, org, site) {
  return files.readJson(recordPath(org, site));
}

async function saveRecord(files, record) {
  await files.writeJson(recordPath(record.org, record.site), record);
}

async function deleteRecord(files, org, site) {
  await files.delete(recordPath(org, site));
}

async function listRecords(files) {
  const paths = await files.list('tokens/');
  const records = await Promise.all(paths.filter((p) => p.endsWith('.json')).map((p) => files.readJson(p)));
  return records.filter(Boolean);
}

function sealToken(token, config, org, site) {
  return seal(token, loadMasterKey(config.encryptionKey), aadFor(org, site));
}

async function appendAudit(files, org, site, entry) {
  const list = (await files.readJson(auditPath(org, site))) || [];
  list.unshift(entry);
  await files.writeJson(auditPath(org, site), list.slice(0, AUDIT_MAX));
}

async function readAudit(files, org, site) {
  return (await files.readJson(auditPath(org, site))) || [];
}

/** Returns the credential for a record. The decrypted value is registered for log redaction. */
async function credentialFor(record, deps) {
  if (!record.secret) throw new HttpError(409, 'not-configured', 'No GitHub token is configured.');
  const token = open(record.secret, loadMasterKey(deps.config.encryptionKey), aadFor(record.org, record.site));
  deps.secrets.add(token);
  return token;
}

function githubFor(record, deps) {
  let memo;
  return createGitHub({
    owner: record.owner,
    repo: record.repo,
    fetch: deps.fetch,
    log: deps.log,
    secrets: deps.secrets,
    getToken: async () => {
      memo = memo || credentialFor(record, deps);
      return memo;
    },
  });
}

/** The only shape of a token record that ever leaves the broker. */
function publicStatus(record) {
  if (!record) return { configured: false };
  const m = record.meta || {};
  return {
    configured: true,
    owner: record.owner,
    repo: record.repo,
    type: m.type || null,
    last4: m.last4 || null,
    expiresAt: m.expiresAt || null,
    repoAccess: m.repoAccess ?? null,
    permissions: m.permissions || {},
    missingRequired: m.missingRequired || [],
    missingOptional: m.missingOptional || [],
    rateLimit: m.rateLimit || null,
    defaultBranch: m.defaultBranch || null,
    configuredBy: m.configuredBy || null,
    configuredAt: m.configuredAt || null,
    validatedAt: m.validatedAt || null,
    siteCheck: m.siteCheck ? { state: m.siteCheck.state, origin: m.siteCheck.origin, checkedAt: m.siteCheck.checkedAt } : null,
    settings: record.settings || {},
  };
}

module.exports = {
  tokenType,
  loadRecord,
  saveRecord,
  deleteRecord,
  listRecords,
  sealToken,
  appendAudit,
  readAudit,
  credentialFor,
  githubFor,
  publicStatus,
  recordPath,
};
