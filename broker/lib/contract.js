'use strict';

/**
 * Gate 1 inputs: the declared content contract.
 * - Universal Editor models (block-local _{name}.json, models/_{name}.json, or component-models.json)
 * - The block manifest blocks/{name}/block.json with a semver `contentContract`
 */

function flattenFields(fields, out = []) {
  (fields || []).forEach((f) => {
    if (Array.isArray(f.fields)) flattenFields(f.fields, out);
    else if (f.name) {
      out.push({
        name: f.name,
        label: f.label || f.name,
        type: [f.component, f.valueType].filter(Boolean).join(':') || 'text',
        required: Boolean(f.required || (f.validation && f.validation.required)),
        multi: Boolean(f.multi),
      });
    }
  });
  return out;
}

function findModel(json, block) {
  const models = Array.isArray(json) ? json : (json && json.models) || [];
  return models.find((m) => m && m.id === block) || null;
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadModel(gh, { block, ref }) {
  const paths = [`blocks/${block}/_${block}.json`, `models/_${block}.json`, 'component-models.json'];
  for (const path of paths) {
    // eslint-disable-next-line no-await-in-loop
    const json = safeJson(await gh.getRaw(path, ref));
    const model = json && findModel(json, block);
    if (model) return { source: path, fields: flattenFields(model.fields) };
  }
  return null;
}

async function loadManifest(gh, { block, ref }) {
  return safeJson(await gh.getRaw(`blocks/${block}/block.json`, ref));
}

const q = (s) => `“${s}”`;

function diffModels(base, head) {
  if (!base && !head) return { verdict: 'none', changes: [] };
  if (base && !head) {
    return {
      verdict: 'unsafe',
      changes: [{ kind: 'model-removed', message: 'This version removes the content model for this block. Your content would no longer match it.' }],
    };
  }
  const baseFields = base ? base.fields : [];
  const before = new Map(baseFields.map((f) => [f.name, f]));
  const after = new Map(head.fields.map((f) => [f.name, f]));
  const removed = baseFields.filter((f) => !after.has(f.name));
  const added = head.fields.filter((f) => !before.has(f.name));
  const changes = [];

  removed.forEach((r) => {
    const twin = added.find((a) => a.label === r.label);
    if (twin) {
      added.splice(added.indexOf(twin), 1);
      changes.push({
        kind: 'renamed', field: r.name, to: twin.name, unsafe: true, message: `This version renamed the field ${q(r.label)}. Your content still uses the old name.`,
      });
    } else {
      changes.push({
        kind: 'removed', field: r.name, unsafe: true, message: `This version no longer has the field ${q(r.label)}. Content in that field would not show.`,
      });
    }
  });
  added.forEach((a) => {
    changes.push(a.required
      ? {
        kind: 'added-required', field: a.name, unsafe: true, message: `This version needs a new required field, ${q(a.label)}. Your content does not have it.`,
      }
      : {
        kind: 'added-optional', field: a.name, unsafe: false, message: `This version adds an optional field, ${q(a.label)}.`,
      });
  });
  head.fields.forEach((f) => {
    const old = before.get(f.name);
    if (!old) return;
    if (old.type !== f.type) {
      changes.push({
        kind: 'type-changed', field: f.name, from: old.type, to: f.type, unsafe: true, message: `This version changes what kind of content the field ${q(f.label)} holds.`,
      });
    } else if (!old.required && f.required) {
      changes.push({
        kind: 'now-required', field: f.name, unsafe: true, message: `This version makes the field ${q(f.label)} required.`,
      });
    }
  });
  return { verdict: changes.some((c) => c.unsafe) ? 'unsafe' : 'safe', changes };
}

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

/** A major change in contentContract means the content shape changed. */
function compareContracts(baseManifest, headManifest) {
  const from = baseManifest && baseManifest.contentContract;
  const to = headManifest && headManifest.contentContract;
  const b = parseSemver(from);
  const h = parseSemver(to);
  if (!b || !h) return { verdict: 'none', from: from || null, to: to || null };
  if (b[0] !== h[0]) {
    return {
      verdict: 'unsafe',
      from,
      to,
      message: `The developer marked this version as needing a different content structure (content contract ${from} to ${to}).`,
    };
  }
  return { verdict: 'safe', from, to };
}

module.exports = {
  flattenFields, findModel, loadModel, loadManifest, diffModels, parseSemver, compareContracts, safeJson,
};
