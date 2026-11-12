'use strict';

/**
 * Gate 2 helpers: file classification and the DOM contract signature.
 * The signature is a heuristic. It never grants a safe verdict on its own.
 */

const { fileKind } = require('./blocks');

function classifyChanges(files, block) {
  const out = {
    js: [], css: [], docs: [], model: [], manifest: [], other: [],
  };
  files.forEach((f) => out[fileKind(f.filename, block)].push(f.filename));
  const all = files.length;
  const added = files.filter((f) => f.status === 'added').length;
  return {
    ...out,
    total: all,
    onlyAdded: all > 0 && added === all,
    cssDocsOnly: all > 0 && out.js.length + out.model.length + out.manifest.length + out.other.length === 0,
  };
}

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function countNames(list) {
  return list.split(',').filter((s) => s.trim()).length;
}

function domSignature(js) {
  const src = stripComments(js);
  let maxRow = -1;
  let maxCell = -1;
  const bump = (owner, idx) => {
    if (/^block$/.test(owner)) maxRow = Math.max(maxRow, idx);
    else maxCell = Math.max(maxCell, idx);
  };

  src.replace(/\b([\w$]+)\.children\[(\d+)\]/g, (m, owner, idx) => {
    bump(owner, Number(idx));
    return m;
  });
  const destructure = /\[\s*([\w$\s,]*?)\s*\]\s*=\s*(?:\[\s*\.\.\.\s*([\w$.]+)\.children\s*\]|Array\.from\(\s*([\w$.]+)\.children\s*\)|([\w$.]+)\.children\b)/g;
  src.replace(destructure, (m, names, a, b, c) => {
    const owner = (a || b || c || '').split('.').pop();
    bump(owner, countNames(names) - 1);
    return m;
  });
  src.replace(/:nth-child\((\d+)\)/g, (m, n) => {
    maxCell = Math.max(maxCell, Number(n) - 1);
    return m;
  });

  const selectors = new Set();
  src.replace(/querySelector(?:All)?\(\s*(['"`])((?:(?!\1).)+)\1/g, (m, _q, sel) => {
    selectors.add(sel.trim());
    return m;
  });
  const variants = new Set();
  src.replace(/classList\.contains\(\s*(['"`])([\w-]+)\1/g, (m, _q, v) => {
    variants.add(v);
    return m;
  });

  return {
    maxRowIndex: maxRow,
    maxCellIndex: maxCell,
    usesScopeDiv: /:scope\s*>\s*div/.test(src),
    selectors: [...selectors].sort(),
    variants: [...variants].sort(),
    usesImages: [...selectors].some((s) => /\b(picture|img)\b/.test(s)),
    usesLinks: [...selectors].some((s) => /(^|[\s>,])a(\b|\[|$)/.test(s)),
  };
}

const EMPTY = {
  maxRowIndex: -1, maxCellIndex: -1, selectors: [], variants: [], usesScopeDiv: false,
};

function signatureHints(base, head) {
  const b = base || EMPTY;
  const h = head || EMPTY;
  const hints = [];
  if (h.maxCellIndex > b.maxCellIndex) {
    hints.push({ code: 'more-cells', from: b.maxCellIndex + 1, to: h.maxCellIndex + 1 });
  }
  if (h.maxRowIndex > b.maxRowIndex) {
    hints.push({ code: 'more-rows', from: b.maxRowIndex + 1, to: h.maxRowIndex + 1 });
  }
  h.selectors.filter((s) => !b.selectors.includes(s)).forEach((selector) => hints.push({ code: 'new-selector', selector }));
  h.variants.filter((v) => !b.variants.includes(v)).forEach((variant) => hints.push({ code: 'new-variant', variant }));
  return hints;
}

module.exports = {
  classifyChanges, domSignature, signatureHints, stripComments,
};
