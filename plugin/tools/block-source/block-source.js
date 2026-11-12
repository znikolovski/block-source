import { h, clear } from './lib/dom.js';
import {
  resolveRef, siteContext, previewOrigin, LOCAL_REF_KEY, isLocal,
} from './lib/ref.js';
import {
  listBlocks, blockAtIndex, describe, parseHtml,
} from './lib/blocks.js';
import { createBroker, validBrokerUrl } from './lib/broker.js';
import { combineVerdict, hashKey } from './lib/checks.js';
import { runDryRun } from './lib/dryrun-runner.js';
import { connectCanvas } from './lib/canvas.js';
import {
  relativeTime, shortAge, formatDate, personName, safeUrl, plural,
} from './lib/format.js';

const SDK_URL = 'https://da.live/nx/utils/sdk.js';
const DA_ADMIN = 'https://admin.da.live';
const app = document.getElementById('app');

const state = {
  org: null,
  site: null,
  path: '/',
  ref: 'main',
  refSource: 'default',
  token: null,
  actions: {},
  broker: null,
  status: null,
  doc: null,
  blockIndex: null,
  selected: null,
  view: 'block',
  tab: 'history',
  checks: new Map(),
  previews: new Map(),
  canvas: undefined,
  gen: 0,
};

const el = {};

/* ---------- helpers ---------- */

function link(href, text, attrs = {}) {
  const url = safeUrl(href);
  if (!url) return h('span', {}, text);
  return h('a', {
    href: url, target: '_blank', rel: 'noopener noreferrer', ...attrs,
  }, text);
}

function note(kind, ...children) {
  return h('div', { class: `bs-note ${kind}` }, ...children);
}

function loading(text = 'Loading…') {
  return h('p', { class: 'bs-muted' }, text);
}

const ERRORS = {
  'not-configured': 'Block Source is not set up for this site yet. Ask a site administrator to connect GitHub.',
  'no-access': 'You do not have access to this site.',
  unauthenticated: 'Your session has expired. Reload Experience Workspace.',
  'ref-not-found': null,
  network: 'The Block Source service could not be reached. Check your connection and try again.',
};

function errorView(e, retry) {
  let message = ERRORS[e.code] || e.message || 'Something went wrong.';
  if (e.code === 'rate-limited') message = `GitHub is busy. Try again ${e.body && e.body.resetAt ? `after ${formatDate(e.body.resetAt)}` : 'later'}.`;
  if (e.code === 'too-many-requests') message = 'Too many requests. Wait a minute and try again.';
  return note('error', h('p', {}, message), retry ? h('p', {}, h('button', { class: 'bs-btn', type: 'button', onClick: retry }, 'Try again')) : null);
}

function staleNote(data) {
  if (!data || !data.stale) return null;
  return note('warn', `GitHub is not reachable. Showing saved data from ${relativeTime(data.cachedAt)}.`);
}

function readSession(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked
  }
}

function pageUrlOn(origin) {
  const path = state.path.replace(/\/index$/, '/');
  return `${origin}${path}`;
}

/* ---------- shell ---------- */

function renderShell() {
  el.header = h('header', { class: 'bs-header' });
  el.picker = h('div', { class: 'bs-picker' });
  el.insights = h('section', { class: 'bs-glance', 'aria-label': 'Block at a glance' });
  el.tabs = h('nav', { class: 'bs-tabs', role: 'tablist', 'aria-label': 'Block Source' });
  el.panel = h('section', { class: 'bs-panel', role: 'tabpanel' });
  el.footer = h('footer', { class: 'bs-footer' });
  clear(app, el.header, el.picker, el.insights, el.tabs, el.panel, el.footer);
}

function renderHeader() {
  const sel = state.selected;
  const gear = state.status && state.status.isAdmin
    ? h('button', {
      class: 'bs-icon-btn',
      type: 'button',
      title: 'Settings',
      'aria-label': 'Settings',
      'aria-pressed': state.view === 'settings' ? 'true' : 'false',
      onClick: () => {
        state.view = state.view === 'settings' ? 'block' : 'settings';
        render();
      },
    }, '⚙')
    : null;
  const refNote = state.refSource === 'local-override' ? ' (local override)' : '';
  clear(
    el.header,
    h(
      'div',
      { class: 'bs-title' },
      state.view === 'settings'
        ? h('strong', {}, 'Settings')
        : (sel ? [h('strong', {}, sel.name), ' ', sel.variants.map((v) => h('span', { class: 'bs-chip' }, v))] : h('strong', {}, 'Block Source')),
      h('div', { class: 'bs-meta' }, 'Branch ', h('span', { class: 'bs-ref' }, state.ref), refNote),
    ),
    gear,
  );
}

function renderTabs() {
  if (state.view !== 'block' || !state.selected) {
    clear(el.tabs);
    el.tabs.hidden = true;
    return;
  }
  el.tabs.hidden = false;
  const tabs = [['history', 'History'], ['versions', 'Versions'], ['insights', 'Insights'], ['about', 'About']];
  clear(el.tabs, tabs.map(([id, label]) => h('button', {
    type: 'button',
    role: 'tab',
    id: `tab-${id}`,
    'aria-selected': state.tab === id ? 'true' : 'false',
    onClick: () => {
      state.tab = id;
      renderTabs();
      renderPanel();
    },
  }, label)));
}

function renderPicker() {
  if (state.view !== 'block') {
    clear(el.picker);
    return;
  }
  const blocks = state.doc ? listBlocks(state.doc) : [];
  if (state.liveDocument && state.selected) {
    clear(el.picker);
    return;
  }
  if (!blocks.length) {
    clear(el.picker, state.doc ? h('p', { class: 'bs-muted' }, 'This page has no blocks.') : null);
    return;
  }
  const counts = {};
  const select = h(
    'select',
    {
      'aria-label': 'Block',
      onChange: (e) => {
        const b = blocks[Number(e.target.value)];
        if (b) selectBlock(describe(b));
      },
    },
    h('option', { value: '' }, 'Choose a block on this page…'),
    blocks.map((b, i) => {
      counts[b.name] = (counts[b.name] || 0) + 1;
      const total = blocks.filter((x) => x.name === b.name).length;
      return h('option', {
        value: String(i),
        selected: state.selected && state.selected.name === b.name && state.selected.instance === b.instance,
      }, total > 1 ? `${b.name} (${counts[b.name]} of ${total})` : b.name);
    }),
  );
  clear(el.picker, state.liveDocument ? h('p', { class: 'bs-muted bs-small' }, 'Select a block in the document, or choose one here.') : null, select);
}

async function renderFooter() {
  const canvas = state.canvas;
  if (canvas) {
    try {
      const live = await canvas.agent.list();
      state.previews = new Map(live.map((p) => [p.id, p]));
    } catch {
      // canvas reloaded or gone
    }
  }
  if (!state.previews.size) {
    clear(el.footer);
    el.footer.hidden = true;
    return;
  }
  el.footer.hidden = false;
  const branches = [...new Set([...state.previews.values()].map((p) => p.branch))].join(', ');
  clear(el.footer, h(
    'div',
    { class: 'bs-row' },
    h('span', { class: 'bs-small' }, `${plural(state.previews.size, 'block')} previewed from ${branches}. Only you see this, until you reload.`),
    h('button', {
      class: 'bs-btn',
      type: 'button',
      onClick: async () => {
        await state.canvas?.agent.revertAll().catch(() => {});
        state.previews.forEach((p) => state.broker.telemetry('preview-reverted', { block: p.block, branch: p.branch }));
        state.previews.clear();
        renderFooter();
        if (state.tab === 'versions') renderPanel();
      },
    }, 'Revert all'),
  ));
}

function render() {
  renderHeader();
  renderPicker();
  renderGlance();
  renderTabs();
  renderPanel();
  renderFooter();
}

/* ---------- panel ---------- */

async function renderPanel() {
  state.gen += 1;
  const gen = state.gen;
  const current = () => gen === state.gen;
  const panel = el.panel;
  if (state.view === 'settings') {
    panel.removeAttribute('aria-labelledby');
    await renderSettings(panel, current);
    return;
  }
  if (!state.status.configured) {
    clear(panel, note('', ERRORS['not-configured']));
    return;
  }
  const sel = state.selected;
  if (!sel) {
    clear(panel, h('p', { class: 'bs-muted' }, 'Select a block to see where its code comes from, and whether a newer version exists.'));
    return;
  }
  panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
  clear(panel, loading());
  const views = {
    history: renderHistory, versions: renderVersions, about: renderAbout, insights: renderInsights,
  };
  try {
    const content = await views[state.tab](sel, current);
    if (current()) clear(panel, content);
  } catch (e) {
    if (current()) clear(panel, errorView(e, () => renderPanel()));
  }
}

function kindNote(resolved, block) {
  if (!resolved || resolved.kind === 'code') return null;
  if (resolved.kind === 'external') {
    return note('', `The ${block} block comes from ${resolved.source}. Its history is not in this repository.`);
  }
  return note('', `${block} is not a code block in this repository. It may be default content, or a block provided by the platform.`);
}

function fileChips(files) {
  const labels = {
    js: 'Code', css: 'Styles', model: 'Content model', docs: 'Docs', other: 'Other',
  };
  return Object.entries(files || {}).filter(([, list]) => list.length).map(([k, list]) => h('span', { class: 'bs-chip', title: list.map((f) => f.path).join('\n') }, labels[k] || k));
}

function deployedChip(dep) {
  if (!dep) return null;
  const text = {
    'in-use': 'Live code matches',
    'out-of-sync': 'Live code differs',
    'not-deployed': 'Not deployed',
  }[dep.state];
  if (!text) return null;
  const title = {
    'in-use': 'The code served on this branch is this commit.',
    'out-of-sync': 'The code served on this branch is different from this commit. Code sync may still be running.',
    'not-deployed': 'This block has no code served on this branch.',
  }[dep.state];
  return h('span', { class: `bs-chip ${dep.state === 'in-use' ? 'inuse' : 'gen'}`, title }, text);
}

function relationNote(rel) {
  if (!rel || rel.isDefault || rel.behindDefault === undefined) return null;
  if (!rel.behindDefault) return null;
  return note('warn', `This page uses the branch ${rel.activeRef}, which is ${plural(rel.behindDefault, 'commit')} behind ${rel.defaultBranch}.`);
}

async function renderHistory(sel) {
  const q = { block: sel.name, ref: state.ref };
  const [hist, dep] = await Promise.all([
    state.broker.get('/history', q),
    state.broker.get('/deployed', q).catch(() => null),
  ]);
  const kind = kindNote(hist.resolved, sel.name);
  if (kind) return kind;
  if (!hist.commits.length) return note('', 'No commits changed this block on this branch.');
  return h(
    'div',
    { class: 'bs-form' },
    staleNote(hist),
    relationNote(hist.relation),
    h('ol', { class: 'bs-list', 'aria-label': 'Commits that changed this block' }, hist.commits.map((c) => h(
      'li',
      { class: `bs-card${c.inUse ? ' inuse' : ''}` },
      h('div', { class: 'bs-row' }, c.inUse ? h('span', { class: 'bs-chip inuse', title: 'The newest change on this branch is what the page uses.' }, 'In use') : null, c.inUse ? deployedChip(dep) : null),
      h('span', { class: 'bs-subject' }, c.subject),
      h('span', { class: 'bs-meta' }, personName(c.author), ' · ', h('time', { datetime: c.date, title: formatDate(c.date) }, relativeTime(c.date)), ' · ', link(c.url, c.shortSha, { class: 'bs-sha' })),
      h('div', {}, fileChips(c.files)),
    ))),
    h('p', { class: 'bs-small' }, link(`${hist.repoUrl}/commits/${encodeURIComponent(hist.activeRef)}/blocks/${sel.name}`, 'All changes on GitHub')),
  );
}

/* ---------- versions and safe apply ---------- */

const checkKey = (sel, branch) => `${sel.name}:${sel.instance}:${branch}`;

async function renderVersions(sel) {
  const params = { block: sel.name, ref: state.ref };
  if (state.freshBranches) params.fresh = '1';
  state.freshBranches = false;
  const data = await state.broker.get('/branches', params);
  const again = h('p', { class: 'bs-small' }, h('button', {
    class: 'bs-btn', type: 'button',
    onclick: () => {
      state.freshBranches = true;
      renderPanel();
    },
  }, 'Check again'), ` Branches checked ${relativeTime(data.cachedAt)}.`);
  const intro = h('p', { class: 'bs-muted bs-small' }, 'Branches with a newer version of this block. Check one to see if it works with your content, then preview it on the canvas. Nothing is saved or published.');
  const notes = [staleNote(data)];
  if (data.truncated) notes.push(note('', `Only the most recent ${data.scanned} of ${data.candidates} branches were checked.`));
  if (!data.branches.length) return h('div', { class: 'bs-form' }, notes, note('', 'No branch has a newer version of this block.'), again);
  return h('div', { class: 'bs-form' }, intro, notes, h('ul', { class: 'bs-list' }, data.branches.map((b) => branchCard(sel, b))), again);
}

function branchCard(sel, b) {
  const area = h('div', { class: 'bs-check' });
  const card = h(
    'li',
    { class: 'bs-card' },
    h('div', { class: 'bs-row' }, h('strong', { class: 'bs-ref' }, b.name), b.pr ? link(b.pr.url, `#${b.pr.number} ${b.pr.title}`, { class: 'bs-small' }) : null),
    b.newest ? h('span', { class: 'bs-subject' }, b.newest.subject) : null,
    h(
      'span',
      { class: 'bs-meta' },
      b.newest ? `${personName(b.newest.author)} · ` : '',
      h('time', { datetime: b.headDate, title: formatDate(b.headDate) }, relativeTime(b.headDate)),
      ` · ${plural(b.blockAheadBy || b.aheadBy, 'change')} to this block`,
    ),
    area,
  );
  renderCheck(area, sel, b);
  return card;
}

function renderCheck(area, sel, b) {
  const check = state.checks.get(checkKey(sel, b.name));
  const actions = h('div', { class: 'bs-row' });
  if (!b.previewable) {
    clear(area, h('p', { class: 'bs-small bs-muted' }, `Cannot be previewed: ${b.previewReason}`), h('div', { class: 'bs-row' }, link(b.compareUrl, 'Compare on GitHub', { class: 'bs-small' })));
    return;
  }
  if (!check) {
    actions.append(h('button', { class: 'bs-btn primary', type: 'button', onClick: () => runCheck(area, sel, b) }, 'Check with my content'));
    actions.append(link(b.compareUrl, 'Compare on GitHub', { class: 'bs-small' }));
    clear(area, actions);
    return;
  }
  if (check.running) {
    clear(area, h('div', { class: 'bs-verdict running', role: 'status' }, check.step || 'Checking…'));
    return;
  }
  if (check.error) {
    clear(area, errorView(check.error, () => runCheck(area, sel, b)));
    return;
  }
  clear(area, verdictView(area, sel, b, check));
}

async function runCheck(area, sel, b) {
  const key = checkKey(sel, b.name);
  const update = (patch) => {
    state.checks.set(key, { ...(state.checks.get(key) || {}), ...patch });
    if (area.isConnected) renderCheck(area, sel, b);
  };
  const started = performance.now();
  update({ running: true, step: 'Checking the content model…' });
  try {
    const compat = await state.broker.get('/compat', { block: sel.name, ref: state.ref, branch: b.name });
    let dry = null;
    if (compat.verdict === 'needs-dry-run' && compat.previewable) {
      update({ step: 'Trying the new code with your content…' });
      const cacheKey = `block-source:dryrun:${await hashKey(sel.html, compat.headSha)}`;
      dry = readSession(cacheKey);
      if (!dry) {
        dry = await runDryRun({
          block: sel.name,
          html: sel.html,
          previewOrigin: compat.previewOrigin,
          ownOrigin: window.location.origin,
          harnessOnBranch: state.refSource === 'hostname',
          getModule: () => state.broker.get('/module', { block: sel.name, branch: b.name }),
        });
        if (!dry.unavailable) writeSession(cacheKey, dry);
      }
      if (dry.unavailable) dry = null;
    }
    const final = combineVerdict(compat, dry, sel.shape);
    state.broker.telemetry('compat-checked', {
      block: sel.name, branch: b.name, verdict: final.verdict, durationMs: Math.round(performance.now() - started),
    });
    update({
      running: false, compat, dry, final, error: null,
    });
  } catch (e) {
    update({ running: false, error: e });
  }
}

function contactView(compat) {
  const c = compat.contact || {};
  const parts = [];
  if (c.author) {
    const who = c.author.noreply || !c.author.email
      ? personName(c.author)
      : h('a', { href: `mailto:${c.author.email}` }, personName(c.author));
    parts.push(h('p', { class: 'bs-small' }, 'Ask ', who, c.commit ? ` about “${c.commit.subject}”` : '', '.'));
  }
  if (c.pr) parts.push(h('p', { class: 'bs-small' }, 'Discussion: ', link(c.pr.url, `pull request #${c.pr.number}`), '.'));
  if (compat.sample) parts.push(h('p', { class: 'bs-small' }, link(compat.sample.url, 'See a page that already uses the new version'), '.'));
  return parts;
}

function verdictView(area, sel, b, check) {
  const { final, compat } = check;
  const previewId = `${sel.name}:${sel.instance}`;
  const applied = state.previews.get(previewId);
  const reasons = final.reasons.length ? h('ul', {}, final.reasons.map((r) => h('li', {}, r.message))) : null;
  const notes = (final.notes || []).map((n) => h('p', { class: 'bs-small' }, n.message));
  const again = h('button', {
    class: 'bs-btn',
    type: 'button',
    onClick: () => {
      state.checks.delete(checkKey(sel, b.name));
      runCheck(area, sel, b);
    },
  }, 'Check again');
  const pageLink = link(pageUrlOn(compat.previewOrigin), 'Open the page on this branch', { class: 'bs-small' });

  if (final.verdict === 'safe') {
    const actions = h('div', { class: 'bs-row' });
    if (applied && applied.branch === b.name) {
      actions.append(h('button', { class: 'bs-btn', type: 'button', onClick: () => revertPreview(area, sel, b) }, 'Revert'));
    } else {
      actions.append(h('button', { class: 'bs-btn primary', type: 'button', onClick: () => applyPreview(area, sel, b, check) }, 'Preview on canvas'));
    }
    actions.append(pageLink);
    return h(
      'div',
      { class: 'bs-verdict safe', role: 'status' },
      h('strong', {}, applied && applied.branch === b.name ? 'Previewing on the canvas' : 'Works with your content'),
      reasons,
      notes,
      check.applyError ? note('error', check.applyError) : null,
      actions,
    );
  }
  if (final.verdict === 'blocked') {
    return h(
      'div',
      { class: 'bs-verdict blocked', role: 'status' },
      h('strong', {}, 'This version does not fit your content'),
      reasons,
      contactView(compat),
      h('div', { class: 'bs-row' }, again, link(b.compareUrl, 'Compare on GitHub', { class: 'bs-small' })),
    );
  }
  return h(
    'div',
    { class: 'bs-verdict unknown', role: 'status' },
    h('strong', {}, 'Could not confirm that this version works'),
    reasons,
    h('p', { class: 'bs-small' }, 'You can still look at the whole page on the branch. It does not change your page.'),
    contactView(compat),
    h('div', { class: 'bs-row' }, again, pageLink),
  );
}

async function getCanvas() {
  // Not cached when missing: the canvas may still be loading, or may have been reloaded.
  if (!state.canvas) state.canvas = await connectCanvas({ org: state.org, site: state.site }).catch(() => null);
  return state.canvas;
}

async function applyPreview(area, sel, b, check) {
  const key = checkKey(sel, b.name);
  const setError = (msg) => {
    state.checks.set(key, { ...state.checks.get(key), applyError: msg });
    renderCheck(area, sel, b);
  };
  const canvas = await getCanvas();
  if (!canvas) {
    setError('The canvas did not answer. Wait for the page preview to finish loading and try again. If this keeps happening, the site does not load the Block Source agent yet (see the README); use “Open the page on this branch” meanwhile.');
    return;
  }
  const origin = check.compat.previewOrigin;
  const getModule = () => state.broker.get('/module', { block: sel.name, branch: b.name });
  const args = {
    block: sel.name,
    instance: sel.instance,
    html: sel.html,
    moduleUrl: `${origin}/blocks/${sel.name}/${sel.name}.js`,
    cssUrl: `${origin}/blocks/${sel.name}/${sel.name}.css`,
    branch: b.name,
    sha: check.compat.headSha,
  };
  try {
    if (check.dry && check.dry.strategy === 'module-source') args.code = (await getModule()).code;
    try {
      await canvas.agent.apply(args);
    } catch (e) {
      if (e.phase !== 'import' || args.code) throw e;
      args.code = (await getModule()).code;
      await canvas.agent.apply(args);
    }
    state.previews.set(`${sel.name}:${sel.instance}`, {
      block: sel.name, instance: sel.instance, branch: b.name, sha: check.compat.headSha,
    });
    state.checks.set(key, { ...state.checks.get(key), applyError: null });
    state.broker.telemetry('preview-applied', { block: sel.name, branch: b.name });
  } catch (e) {
    setError(e.phase === 'find'
      ? 'This block is not on the canvas yet. Preview the page first, then try again.'
      : `The preview did not work: ${e.message}`);
    return;
  }
  renderPanel();
  renderFooter();
}

async function revertPreview(area, sel, b) {
  const id = `${sel.name}:${sel.instance}`;
  await state.canvas?.agent.revert(id).catch(() => {});
  state.previews.delete(id);
  state.broker.telemetry('preview-reverted', { block: sel.name, branch: b.name });
  renderCheck(area, sel, b);
  renderFooter();
}

/* ---------- about ---------- */

const generatedChip = (on) => (on ? h('span', { class: 'bs-chip gen', title: 'Written by Block Source from the code, because the developer did not document it.' }, 'Generated') : null);

function shapeView(shape) {
  if (!shape) return h('p', { class: 'bs-muted' }, 'Not documented.');
  if (shape.type === 'table') {
    return h(
      'table',
      { class: 'bs-table' },
      h('thead', {}, h('tr', {}, shape.headers.map((c) => h('th', {}, c)))),
      h('tbody', {}, shape.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))),
    );
  }
  if (shape.type === 'fields') {
    return h(
      'table',
      { class: 'bs-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Kind'), h('th', {}, 'Required'))),
      h('tbody', {}, shape.fields.map((f) => h('tr', {}, h('td', {}, f.label), h('td', {}, f.type), h('td', {}, f.required ? 'Yes' : 'No')))),
    );
  }
  return h('p', {}, shape.text, ' ', generatedChip(shape.source === 'generated'));
}

/** What the block is for and how to author it. Usage, options and ownership are in Insights. */
async function renderAbout(sel) {
  const s = await state.broker.get('/summary', { block: sel.name, ref: state.ref });
  const kind = kindNote({ kind: s.kind, source: s.source }, sel.name);
  if (kind) return kind;
  return h(
    'div',
    { class: 'bs-form' },
    h('div', {}, h('h3', {}, 'What it does'), h('p', {}, s.description || 'Not documented.', ' ', generatedChip(s.descriptionSource === 'generated'))),
    h('div', {}, h('h3', {}, 'Content'), shapeView(s.contentShape)),
    s.sample ? h('p', {}, link(s.sample.startsWith('/') ? `${state.pageOrigin}${s.sample}` : s.sample, 'See a sample page')) : null,
  );
}

/* ---------- insights ---------- */

const getInsights = (sel) => state.broker.get('/insights', { block: sel.name, ref: state.ref });

function openTab(id) {
  state.tab = id;
  renderTabs();
  renderPanel();
}

function usedOnText(used) {
  if (!used) return null;
  return `${used.count}${used.complete ? '' : '+'}`;
}

function issuesText(issues) {
  if (!issues || issues.state !== 'ok') return '?';
  return String(issues.open);
}

/** The at-a-glance strip above the tabs. Each figure opens the Insights tab. */
async function renderGlance() {
  const sel = state.selected;
  if (state.view !== 'block' || !sel || !state.status || !state.status.configured) {
    clear(el.insights);
    el.insights.hidden = true;
    return;
  }
  el.insights.hidden = false;
  const key = `${sel.name}:${state.ref}`;
  el.insights.dataset.key = key;
  const tile = (value, label, title) => h('button', {
    class: 'bs-stat', type: 'button', title, onClick: () => openTab('insights'),
  }, h('span', { class: 'bs-stat-value' }, value), h('span', { class: 'bs-stat-label' }, label));
  clear(el.insights, tile('…', 'pages'), tile('…', 'last change'), tile('…', 'open issues'), tile('…', 'in progress'));
  let data;
  try {
    data = await getInsights(sel);
  } catch {
    if (el.insights.dataset.key === key) clear(el.insights);
    el.insights.hidden = true;
    return;
  }
  if (el.insights.dataset.key !== key) return;
  if (data.kind !== 'code') {
    clear(el.insights);
    el.insights.hidden = true;
    return;
  }
  const used = data.usedOn;
  const work = data.work;
  clear(
    el.insights,
    tile(usedOnText(used) || '–', used && used.count === 1 ? 'page uses it' : 'pages use it', used ? `Counted ${relativeTime(used.scannedAt)}` : 'Not counted yet'),
    tile(data.lastChanged ? shortAge(data.lastChanged.date) : '–', 'since change', data.lastChanged ? `${formatDate(data.lastChanged.date)} by ${personName(data.lastChanged.author)}` : 'No changes found'),
    tile(issuesText(data.issues), data.issues && data.issues.open === 1 ? 'open issue' : 'open issues', data.issues && data.issues.state !== 'ok' ? 'Issues could not be read' : 'Open GitHub issues about this block'),
    tile(work ? String(work.branches.length) : '?', 'in progress', 'Branches with unreleased changes to this block'),
  );
}

/** An Insights card: a header (title, optional count, optional action) and a body. */
function card(title, { count, action, id } = {}, ...body) {
  return h(
    'section',
    { class: 'bs-insight', 'aria-labelledby': id },
    h(
      'header',
      { class: 'bs-insight-head' },
      h('h3', { id }, title, count == null ? null : h('span', { class: 'bs-count' }, String(count))),
      action || null,
    ),
    ...body,
  );
}

const headLink = (href, text) => (safeUrl(href) ? h('a', {
  class: 'bs-head-link', href: safeUrl(href), target: '_blank', rel: 'noopener',
}, text, h('span', { 'aria-hidden': 'true' }, ' ↗')) : null);

const headBtn = (text, onClick) => h('button', { class: 'bs-head-link', type: 'button', onClick }, text);

const empty = (text, tone = '') => h('p', { class: `bs-empty ${tone}`.trim() }, text);

const PAGES_SHOWN = 6;

function pageList(pages) {
  const daEdit = (p) => `https://da.live/edit#/${state.org}/${state.site}${p === '/' ? '/index' : p}`;
  const sorted = [...pages].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  const row = (p) => h('li', {}, h('a', {
    href: daEdit(p), target: '_blank', rel: 'noopener', title: `Open ${p} in DA`,
  }, p === '/' ? h('span', {}, '/ ', h('span', { class: 'bs-muted' }, '(home)')) : p));
  const list = h('ul', { class: 'bs-pages' }, sorted.slice(0, PAGES_SHOWN).map(row));
  if (sorted.length <= PAGES_SHOWN) return list;
  const more = h('button', {
    class: 'bs-more',
    type: 'button',
    onClick: () => {
      clear(list, sorted.map(row));
      list.classList.add('all');
      more.remove();
    },
  }, `Show all ${sorted.length} pages`);
  return h('div', {}, list, more);
}

function usedOnSection(used) {
  const admin = state.status && state.status.isAdmin;
  const body = h('div', { class: 'bs-insight-body' });
  const recount = async (e) => {
    e.currentTarget.disabled = true;
    clear(body, loading('Counting… this can take a minute.'));
    try {
      await state.broker.post('/admin/usage-scan');
      state.broker.invalidate();
      renderGlance();
      renderPanel();
    } catch (err) {
      clear(body, errorView(err));
    }
  };
  const action = admin ? headBtn(used ? 'Count again' : 'Count now', recount) : null;
  if (!used) {
    clear(body, empty(admin ? 'Pages have not been counted yet.' : 'Pages have not been counted yet. A site administrator can count them.'));
    return card('Used on', { action, id: 'bs-in-used' }, body);
  }
  const share = used.total ? Math.round((used.count / used.total) * 100) : null;
  clear(
    body,
    h(
      'div',
      { class: 'bs-headline' },
      h('strong', {}, `${used.count}${used.complete ? '' : '+'}`),
      h('span', {}, used.count === 1 ? ' page' : ' pages', used.total ? h('span', { class: 'bs-muted' }, ` of ${used.total}`) : null),
      share != null ? h('span', { class: 'bs-share' }, `${share}%`) : null,
    ),
    share != null ? h('div', {
      class: 'bs-bar', role: 'img', 'aria-label': `${share}% of pages`,
    }, h('span', { style: `width:${Math.max(share, used.count ? 2 : 0)}%` })) : null,
    used.count ? pageList(used.pages) : empty('No page uses this block. It may be safe to retire.'),
    h('p', { class: 'bs-meta' }, `Counted ${relativeTime(used.scannedAt)}`, used.count > used.pages.length ? ` · showing ${used.pages.length} of ${used.count}` : ''),
  );
  return card('Used on', { action, id: 'bs-in-used' }, body);
}

function variantsSection(data) {
  if (!data.variants || !data.variants.length) return null;
  const declared = new Set(data.declaredVariants || []);
  const max = Math.max(1, ...data.variants.map((v) => v.pages || 0));
  if (data.variants.length === 1 && data.variants[0].name === 'default') {
    return card('Options in use', { id: 'bs-in-options' }, empty('Every page uses the block without options.'));
  }
  return card(
    'Options in use',
    { id: 'bs-in-options' },
    h('ul', { class: 'bs-bars' }, data.variants.map((v) => h(
      'li',
      {},
      h(
        'span',
        { class: 'bs-bar-name' },
        v.name === 'default' ? h('span', { class: 'bs-muted' }, 'Default') : v.name,
        v.name !== 'default' && declared.size && !declared.has(v.name) ? h('span', { class: 'bs-chip gen', title: 'Used on pages, but not documented by the developer.' }, 'Undocumented') : null,
      ),
      h('span', { class: 'bs-bar' }, h('span', { style: `width:${((v.pages || 0) / max) * 100}%` })),
      h('span', { class: 'bs-bar-count' }, v.pages ? String(v.pages) : h('span', { class: 'bs-muted', title: 'Documented but not used on any page' }, '0')),
    ))),
  );
}

function lastChangeSection(last) {
  if (!last) return null;
  return card(
    'Last change',
    { id: 'bs-in-last', action: headLink(last.url, 'Commit') },
    h(
      'div',
      { class: 'bs-insight-body' },
      h('p', {}, h('time', { datetime: last.date, title: formatDate(last.date) }, relativeTime(last.date)), h('span', { class: 'bs-muted' }, ' by '), personName(last.author)),
      last.subject ? h('p', { class: 'bs-quote', title: last.subject }, last.shortSha ? h('span', { class: 'bs-sha' }, last.shortSha) : null, ' ', last.subject) : null,
    ),
  );
}

/** The branch whose code the author sees for this block: a canvas preview's, else the page's. */
function versionInView(sel) {
  const preview = state.previews.get(`${sel.name}:${sel.instance}`);
  return preview ? { branch: preview.branch, previewed: true } : { branch: state.ref, previewed: false };
}

function shotView(area, sel, shot) {
  const retake = h('button', { class: 'bs-head-link', type: 'button', onClick: () => takeShot(area, sel, shot) }, 'Take again');
  if (shot.state === 'taking') {
    clear(area, h('p', { class: 'bs-meta' }, 'Taking a screenshot of the block on the canvas…'));
  } else if (shot.state === 'none') {
    clear(area, h('p', { class: 'bs-meta' }, shot.reason, ' '), retake);
  } else {
    const include = h('input', { type: 'checkbox', checked: shot.include, onChange: (e) => { shot.include = e.target.checked; } });
    clear(
      area,
      h('img', {
        class: 'bs-shot-img', src: shot.dataUrl, alt: `Screenshot of the ${sel.name} block`,
      }),
      h('div', { class: 'bs-row' }, h('label', { class: 'bs-check' }, include, ' Attach this screenshot'), retake),
      shot.fits ? null : h('p', { class: 'bs-meta' }, 'The block is very large, so the screenshot is low resolution.'),
    );
  }
}

async function takeShot(area, sel, shot) {
  Object.assign(shot, { state: 'taking', dataUrl: null });
  shotView(area, sel, shot);
  const canvas = await getCanvas();
  if (!canvas) {
    Object.assign(shot, { state: 'none', reason: 'The canvas did not answer, so no screenshot will be attached.' });
  } else {
    try {
      const r = await canvas.agent.capture({ block: sel.name, instance: sel.instance });
      Object.assign(shot, {
        state: 'ready', dataUrl: r.dataUrl, fits: r.fits !== false, include: true,
      });
    } catch (e) {
      Object.assign(shot, {
        state: 'none',
        reason: e.phase === 'find' ? 'The block was not found on the canvas, so no screenshot will be attached.' : 'The screenshot could not be taken, so none will be attached.',
      });
    }
  }
  shotView(area, sel, shot);
}

/** The form to raise a GitHub issue about the block, with a screenshot from the canvas. */
function reportForm(body, sel, restore) {
  const { branch, previewed } = versionInView(sel);
  const shot = { state: 'taking' };
  const shotArea = h('div', { class: 'bs-shot' });
  const title = h('input', {
    type: 'text', name: 'title', required: true, maxlength: '120', placeholder: 'For example: Tabs overlap the text on mobile',
  });
  const details = h('textarea', {
    name: 'details', required: true, rows: '5', maxlength: '5000', placeholder: 'What did you do, what did you expect, and what happened instead?',
  });
  const status = h('div', {});
  const submit = h('button', { class: 'bs-btn primary', type: 'submit' }, 'Raise issue');
  const repo = state.status && state.status.repo ? `${state.status.owner}/${state.status.repo}` : 'the site repository';
  const form = h(
    'form',
    {
      class: 'bs-form bs-report',
      onSubmit: async (e) => {
        e.preventDefault();
        if (!title.value.trim() || !details.value.trim()) return;
        submit.disabled = true;
        submit.textContent = 'Raising…';
        clear(status);
        try {
          const r = await state.broker.post('/issues', {
            block: sel.name,
            branch,
            title: title.value,
            details: details.value,
            page: state.path,
            screenshot: shot.state === 'ready' && shot.include ? shot.dataUrl : null,
          });
          state.broker.invalidate();
          renderGlance();
          clear(
            body,
            note('ok', h('p', {}, 'Issue ', link(r.url, `#${r.number}`), ' raised in ', repo, '.', r.screenshot ? ' The screenshot is attached.' : '')),
            h('div', { class: 'bs-row' }, h('button', { class: 'bs-btn', type: 'button', onClick: () => renderPanel() }, 'Done')),
          );
        } catch (err) {
          submit.disabled = false;
          submit.textContent = 'Raise issue';
          clear(status, errorView(err));
        }
      },
    },
    h('p', { class: 'bs-meta' }, 'About ', h('span', { class: 'bs-ref' }, sel.name), ' on branch ', h('span', { class: 'bs-ref' }, branch), previewed ? ' (previewed on the canvas)' : '', ` · page ${state.path}`),
    h('label', {}, 'Title', title),
    h('label', {}, 'What is wrong?', details),
    shotArea,
    h('p', { class: 'bs-meta' }, `The issue is opened in ${repo} by the site's GitHub account, with your name as the reporter. Anyone who can see the issue can open the screenshot.`),
    status,
    h('div', { class: 'bs-row' }, submit, h('button', { class: 'bs-btn', type: 'button', onClick: restore }, 'Cancel')),
  );
  clear(body, form);
  title.focus();
  takeShot(shotArea, sel, shot);
}

function issuesSection(issues, sel) {
  if (!issues) return null;
  const ok = issues.state === 'ok';
  let body;
  if (issues.state === 'no-permission') {
    body = note('warn', 'Block Source cannot read issues. A site administrator can give the GitHub token the Issues permission.');
  } else if (issues.state === 'disabled') {
    body = empty('Issues are turned off for this repository.');
  } else if (!ok) {
    body = empty('Issues could not be read right now.');
  } else if (!issues.open) {
    body = empty('✓ No open issues', 'good');
  } else {
    body = h('ul', { class: 'bs-rows' }, issues.items.map((i) => h(
      'li',
      {},
      h('a', { href: safeUrl(i.url), target: '_blank', rel: 'noopener' }, i.title),
      h('span', { class: 'bs-meta' }, `#${i.number} · updated ${relativeTime(i.updatedAt)}`, i.match === 'label' ? null : ' · mentions the block'),
    )));
  }
  const wrap = h('div', { class: 'bs-insight-body' });
  const show = () => clear(wrap, body, h('div', { class: 'bs-row' }, h('button', {
    class: 'bs-btn', type: 'button', onClick: () => reportForm(wrap, sel, show),
  }, 'Report a problem')));
  show();
  return card('Open issues', { count: ok ? issues.open : null, id: 'bs-in-issues', action: headLink(issues.searchUrl, 'GitHub') }, wrap);
}

function workSection(work) {
  if (!work) return null;
  const action = work.branches.length ? headBtn('Check in Versions', () => openTab('versions')) : null;
  return card(
    'In progress',
    { count: work.branches.length || null, id: 'bs-in-work', action },
    work.branches.length ? h('ul', { class: 'bs-rows' }, work.branches.map((b) => h(
      'li',
      {},
      h('span', { class: 'bs-row-title' }, b.subject || b.name),
      h('span', { class: 'bs-meta' }, h('span', { class: 'bs-ref' }, b.name), ` · ${relativeTime(b.headDate)}`, b.pr ? [' · ', link(b.pr.url, `PR #${b.pr.number}${b.pr.draft ? ' (draft)' : ''}`)] : ' · no pull request yet'),
    ))) : empty('No branch is changing this block.'),
    work.truncated ? h('p', { class: 'bs-meta' }, 'Only the most recently active branches were checked.') : null,
  );
}

function initials(name) {
  const parts = String(name || '?').replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function ownersSection(owners) {
  if (!owners || !owners.people || !owners.people.length) return null;
  return card(
    'Who to ask',
    { id: 'bs-in-owners' },
    h('p', { class: 'bs-meta' }, owners.source === 'codeowners' ? 'Owners named in the repository' : 'The people who changed it most'),
    h('ul', { class: 'bs-people' }, owners.people.map((p) => {
      const name = p.handle || personName(p);
      return h(
        'li',
        {},
        h('span', { class: 'bs-avatar', 'aria-hidden': 'true' }, initials(p.name || p.handle)),
        h(
          'span',
          { class: 'bs-person' },
          safeUrl(p.url) ? h('a', { href: safeUrl(p.url), target: '_blank', rel: 'noopener' }, name) : name,
          p.changes ? h('span', { class: 'bs-meta' }, `${plural(p.changes, 'change')} · last ${relativeTime(p.last)}`) : null,
        ),
      );
    })),
  );
}

function docsSection(docs) {
  if (!docs) return null;
  const items = [
    [docs.readme, 'README'],
    [docs.contentModel, 'Content model', docs.contentModel ? null : 'authors must guess the structure'],
    [docs.description === 'written', 'Description', { generated: 'generated by Block Source', missing: 'missing' }[docs.description]],
    [docs.sample, 'Sample page'],
  ];
  const done = items.filter(([ok]) => ok).length;
  return card(
    'Documentation',
    { id: 'bs-in-docs', action: h('span', { class: `bs-score ${done === items.length ? 'good' : ''}`.trim() }, `${done} of ${items.length}`) },
    h('ul', { class: 'bs-checks' }, items.map(([ok, text, detail]) => h(
      'li',
      { class: ok ? 'yes' : 'no' },
      h('span', { class: 'bs-tick', 'aria-label': ok ? 'Done' : 'Missing' }, ok ? '✓' : '–'),
      h('span', {}, text, detail ? h('span', { class: 'bs-meta' }, ` · ${detail}`) : null),
    ))),
  );
}

async function renderInsights(sel) {
  const data = await getInsights(sel);
  const kind = kindNote({ kind: data.kind, source: data.source }, sel.name);
  if (kind) return h('div', { class: 'bs-insights' }, kind, usedOnSection(data.usedOn));
  return h(
    'div',
    { class: 'bs-insights' },
    usedOnSection(data.usedOn),
    variantsSection(data),
    lastChangeSection(data.lastChanged),
    issuesSection(data.issues, sel),
    workSection(data.work),
    ownersSection(data.owners),
    docsSection(data.docs),
  );
}

/* ---------- settings (administrators) ---------- */

function patUrl(owner, repo) {
  const p = new URLSearchParams({
    name: `Block Source ${state.org}/${state.site}`.slice(0, 40),
    description: `Read-only access for Block Source in Experience Workspace (${owner}/${repo}).`,
    target_name: owner,
    expires_in: '90',
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
    issues: 'write',
    checks: 'read',
    statuses: 'read',
  });
  return `https://github.com/settings/personal-access-tokens/new?${p}`;
}

function permissionList(perms = {}) {
  const labels = {
    contents: 'Contents (required)', metadata: 'Metadata (required)', pull_requests: 'Pull requests', issues: 'Issues (read and write)', checks: 'Checks', statuses: 'Commit statuses',
  };
  return h('div', { class: 'bs-perm' }, Object.entries(labels).map(([k, label]) => {
    const v = perms[k] || 'unknown';
    return [h('span', { class: v }, v === 'granted' ? '✓' : (v === 'missing' ? '✗' : '?')), h('span', {}, label)];
  }));
}

async function adminAction(button, fn, out) {
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    clear(out, errorView(e));
    return;
  } finally {
    button.disabled = false;
  }
  state.broker.invalidate();
}

function statusCard(t) {
  if (!t.configured) return note('warn', 'GitHub is not connected yet. Authors cannot see block history until a token is added.');
  const live = t.live;
  const items = [
    h('p', {}, h('strong', {}, `${t.owner}/${t.repo}`), ` · ${t.type === 'fine-grained' ? 'Fine-grained' : 'Classic'} token ••••${t.last4 || ''}`),
    t.expiresAt ? h('p', { class: 'bs-small' }, `Expires ${formatDate(t.expiresAt)}`) : h('p', { class: 'bs-small' }, 'No expiry date reported.'),
    permissionList(t.permissions),
    t.rateLimit ? h('p', { class: 'bs-small bs-muted' }, `GitHub requests left this hour: ${t.rateLimit.remaining} of ${t.rateLimit.limit}`) : null,
    t.configuredBy ? h('p', { class: 'bs-small bs-muted' }, `Added by ${t.configuredBy.name || t.configuredBy.email || t.configuredBy.id} ${relativeTime(t.configuredAt)}`) : null,
  ];
  if (live && !live.ok && live.error) items.unshift(note('error', live.error.message, live.error.ssoUrl ? [' ', link(live.error.ssoUrl, 'Authorise')] : null));
  else if (live && live.status && live.status.expiresSoon) items.unshift(note('warn', 'The token expires soon. Add a new token to avoid interruption.'));
  else if (live && live.ok) items.unshift(note('ok', 'Connected. The token works.'));
  if (t.siteCheck && t.siteCheck.state === 'unverified') {
    items.push(note('warn', `Could not confirm that ${t.owner}/${t.repo} is the code for this site, because ${t.siteCheck.origin} did not serve scripts/scripts.js or styles/styles.css. Check the repository name.`));
  }
  return h('div', { class: 'bs-card' }, items);
}

function tokenForm(t, out, refresh) {
  const owner = h('input', { name: 'owner', value: t.owner || (t.siteConfig && t.siteConfig.owner) || state.org, autocomplete: 'off', required: true });
  const repo = h('input', { name: 'repo', value: t.repo || (t.siteConfig && t.siteConfig.repo) || state.site, autocomplete: 'off', required: true });
  const token = h('input', {
    name: 'token', type: 'password', required: true, autocomplete: 'new-password', spellcheck: 'false', placeholder: 'github_pat_…',
  });
  const submit = h('button', { class: 'bs-btn primary', type: 'submit' }, t.configured ? 'Replace token' : 'Save and test');
  const help = h('p', { class: 'bs-small' }, link(patUrl(owner.value || 'OWNER', repo.value || 'REPO'), 'Create a fine-grained token on GitHub'), ' with read-only access to this one repository. The token is tested before it is saved, and it is never shown again.');
  const form = h(
    'form',
    {
      class: 'bs-form',
      onSubmit: (e) => {
        e.preventDefault();
        adminAction(submit, async () => {
          const body = { owner: owner.value.trim(), repo: repo.value.trim(), token: token.value.trim() };
          token.value = '';
          await state.broker.post('/admin/token', body);
          state.status = await state.broker.get('/status', {}, { fresh: true });
          refresh();
        }, out);
      },
    },
    h('h3', {}, t.configured ? 'Replace the GitHub connection' : 'Connect GitHub'),
    h('div', { class: 'bs-row' }, h('label', {}, 'Owner', owner), h('label', {}, 'Repository', repo)),
    h('label', {}, 'Token', token),
    help,
    h('div', { class: 'bs-row' }, submit),
  );
  return form;
}

function settingsForm(t, out, refresh) {
  const s = t.settings || {};
  const protectedInput = h('input', { value: (s.protectedBranches || []).join(', '), placeholder: 'release-*, hotfix' });
  const sample = h('input', { value: s.samplePathPattern || '', placeholder: '/library/blocks/{block}' });
  const external = h('textarea', { rows: '3', placeholder: 'embed=Platform block' }, Object.entries(s.external || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const submit = h('button', { class: 'bs-btn', type: 'submit' }, 'Save settings');
  return h(
    'form',
    {
      class: 'bs-form',
      onSubmit: (e) => {
        e.preventDefault();
        adminAction(submit, async () => {
          const ext = {};
          external.value.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
            const [k, ...v] = l.split('=');
            if (k && v.length) ext[k.trim()] = v.join('=').trim();
          });
          await state.broker.post('/admin/settings', {
            settings: {
              protectedBranches: protectedInput.value.split(',').map((x) => x.trim()).filter(Boolean),
              samplePathPattern: sample.value.trim() || undefined,
              external: ext,
            },
          });
          refresh();
        }, out);
      },
    },
    h('h3', {}, 'Settings'),
    h('label', {}, 'Branches never offered to authors (comma separated, * allowed)', protectedInput),
    h('label', {}, 'Sample page path, used when a version does not fit ({block} is replaced)', sample),
    h('label', {}, 'Blocks that are not in this repository (one per line: name=where it comes from)', external),
    h('div', { class: 'bs-row' }, submit),
  );
}

async function renderSettings(panel, current) {
  clear(panel, loading());
  let t;
  try {
    t = await state.broker.get('/admin/token', {}, { fresh: true });
  } catch (e) {
    if (current()) clear(panel, errorView(e, () => renderPanel()));
    return;
  }
  if (!current()) return;
  const out = h('div', { 'aria-live': 'polite' });
  const refresh = () => {
    state.broker.invalidate();
    renderHeader();
    renderPanel();
  };
  const button = (label, fn, cls = 'bs-btn') => {
    const b = h('button', { class: cls, type: 'button' });
    b.textContent = label;
    b.addEventListener('click', () => adminAction(b, fn, out));
    return b;
  };
  const maintenance = t.configured ? h(
    'div',
    { class: 'bs-section' },
    h('h3', {}, 'Maintenance'),
    h(
      'div',
      { class: 'bs-row' },
      button('Test now', async () => {
        await state.broker.post('/admin/token/validate');
        refresh();
      }),
      button('Refresh branch index', async () => {
        const r = await state.broker.post('/admin/index');
        clear(out, note('ok', `Indexed ${plural(r.blocks, 'block')}.`));
      }),
      button('Count block usage', async () => {
        clear(out, loading('Counting… this can take a minute.'));
        const r = await state.broker.post('/admin/usage-scan');
        clear(out, note('ok', `Scanned ${plural(r.pages, 'page')}${r.complete ? '' : ' (stopped early, run again to continue)'}.`));
      }),
      button('Remove token', async () => {
        // eslint-disable-next-line no-alert
        if (!window.confirm('Remove the GitHub token? Authors will no longer see block history.')) return;
        await state.broker.del('/admin/token');
        state.status = await state.broker.get('/status', {}, { fresh: true });
        refresh();
      }, 'bs-btn danger'),
    ),
  ) : null;
  const insights = t.insights && t.insights.oftenBlocked && t.insights.oftenBlocked.length
    ? h('div', { class: 'bs-section' }, h('h3', {}, 'Often blocked'), h('p', { class: 'bs-small bs-muted' }, 'Versions that often do not fit authors\' content. The developers may want to document a new structure.'), h('ul', { class: 'bs-small' }, t.insights.oftenBlocked.map((i) => h('li', {}, `${i.block}: blocked ${i.blocked} of ${plural(i.checks, 'check')}`))))
    : null;
  const audit = (t.audit || []).length
    ? h('div', { class: 'bs-section' }, h('h3', {}, 'Changes'), h('ul', { class: 'bs-small' }, t.audit.map((a) => h('li', {}, `${formatDate(a.at)} · ${a.action} · ${a.actor.name || a.actor.email || a.actor.id}${a.last4 ? ` · ••••${a.last4}` : ''}`))))
    : null;
  clear(
    panel,
    h(
      'div',
      { class: 'bs-form' },
      statusCard(t),
      out,
      tokenForm(t, out, refresh),
      t.configured ? h('div', { class: 'bs-section' }, settingsForm(t, out, refresh)) : null,
      maintenance,
      insights,
      audit,
    ),
  );
}

/* ---------- selection ---------- */

function selectBlock(sel) {
  const prev = state.selected;
  const same = prev && sel && prev.name === sel.name && prev.instance === sel.instance;
  state.selected = sel;
  if (same) return;
  state.view = 'block';
  render();
}

let liveTimer;
function onLiveDocument(payload = {}) {
  if (payload.selection && typeof payload.selection.blockIndex === 'number') state.blockIndex = payload.selection.blockIndex;
  else if (payload.selection) state.blockIndex = null;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    if (payload.html) state.doc = parseHtml(payload.html);
    if (!state.doc) return;
    const b = blockAtIndex(state.doc, state.blockIndex);
    if (b) selectBlock(describe(b));
    else if (!state.selected) renderPicker();
  }, 150);
}

async function loadPlainPage() {
  const url = `${state.pageOrigin}${state.path}.plain.html`;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return;
    state.doc = parseHtml(`<main>${await res.text()}</main>`);
  } catch {
    // page not previewed yet
  }
}

/* ---------- startup ---------- */

function findConfigValue(json, key) {
  if (!json) return null;
  const sheets = json[':type'] === 'multi-sheet' ? (json[':names'] || []).map((n) => json[n] && json[n].data) : [json.data];
  for (const rows of sheets) {
    const row = (rows || []).find((r) => r && r.key === key);
    if (row) return row.value;
  }
  return null;
}

async function brokerUrl() {
  try {
    const url = `${DA_ADMIN}/config/${state.org}/${state.site}/`;
    const res = state.actions.daFetch
      ? await state.actions.daFetch(url)
      : await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
    if (res.ok) {
      const value = validBrokerUrl(findConfigValue(await res.json(), 'blocksource.broker'));
      if (value) return value;
    }
  } catch {
    // fall back to the meta tag
  }
  const meta = document.querySelector('meta[name="block-source-broker"]');
  return meta && meta.content ? validBrokerUrl(meta.content) : null;
}

function fatal(message) {
  clear(app, note('error', message));
}

async function init() {
  let sdk;
  try {
    const mod = await import(SDK_URL);
    sdk = await mod.default;
  } catch {
    fatal('Open Block Source from the library in Experience Workspace.');
    return;
  }
  const { context = {}, token, actions = {} } = sdk;
  const capabilities = sdk.capabilities || context.capabilities || {};
  state.token = token;
  state.actions = actions;
  Object.assign(state, siteContext(context, window.location));
  const ref = resolveRef(window.location, window.localStorage);
  state.ref = ref.ref;
  state.refSource = ref.source;
  if (!state.org || !state.site) {
    fatal('Block Source could not tell which site this is.');
    return;
  }
  // On the site (or DA's proxy of it) pages share the plugin origin; when the plugin is hosted on its own, read them from aem.page.
  state.pageOrigin = ref.source === 'hostname'
    ? window.location.origin
    : (previewOrigin(state.ref, state.site, state.org) || previewOrigin('main', state.site, state.org));

  // DA sends a fresh token on later messages.
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.data && typeof e.data.token === 'string') state.token = e.data.token;
  });

  const base = await brokerUrl();
  if (!base) {
    fatal('Block Source is not set up for this site. A site administrator needs to add the blocksource.broker key to the site configuration.');
    return;
  }
  state.broker = createBroker({
    baseUrl: base, org: state.org, site: state.site, getToken: () => state.token,
  });

  try {
    state.status = await state.broker.get('/status');
  } catch (e) {
    clear(app, errorView(e, () => init()));
    return;
  }
  renderShell();
  if (!state.status.configured && state.status.isAdmin) state.view = 'settings';
  render();
  state.broker.telemetry('panel-opened');

  if (capabilities.liveDocument === 1 && typeof actions.subscribeLiveDocument === 'function') {
    state.liveDocument = true;
    actions.subscribeLiveDocument(onLiveDocument);
  } else {
    await loadPlainPage();
    renderPicker();
  }
}

if (isLocal(window.location.hostname)) {
  // Developer helper: set the branch the local server represents.
  window.blockSourceSetLocalRef = (ref) => {
    if (ref) localStorage.setItem(LOCAL_REF_KEY, ref);
    else localStorage.removeItem(LOCAL_REF_KEY);
  };
}

init();
