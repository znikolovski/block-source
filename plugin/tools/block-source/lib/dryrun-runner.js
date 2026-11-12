/**
 * Runs gate 3 in a hidden iframe. Three strategies, tried in order:
 * 1. the harness on the branch origin (same-origin import of the branch code; needs the plugin on the branch)
 * 2. the harness on the plugin origin importing the branch module URL (needs CORS on aem.page)
 * 3. the harness on the plugin origin with the module source from the broker, imported from a blob: URL
 * A strategy is skipped when its harness never answers or cannot import the module.
 */

const READY_TIMEOUT = 6000;

function runInFrame({
  src, payload, timeoutMs, doc = document,
}) {
  return new Promise((resolve) => {
    const origin = new URL(src).origin;
    const id = Math.random().toString(36).slice(2);
    const iframe = doc.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;opacity:0;pointer-events:none;';
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
      resolve(result);
    };
    function onMessage(e) {
      if (e.source !== iframe.contentWindow || e.origin !== origin || !e.data) return;
      if (e.data.type === 'block-source:harness-ready') {
        clearTimeout(timer);
        timer = setTimeout(() => finish({ ok: false, timedOut: true, phase: 'decorate', error: 'No answer from the check.' }), timeoutMs + 8000);
        iframe.contentWindow.postMessage({ type: 'block-source:dryrun', id, ...payload, timeoutMs }, origin);
      } else if (e.data.type === 'block-source:dryrun-result' && e.data.id === id) {
        const { type, id: _, ...result } = e.data;
        finish(result);
      }
    }
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => finish({ unavailable: true }), READY_TIMEOUT);
    iframe.src = src;
    doc.body.append(iframe);
  });
}

export async function runDryRun({
  block, html, previewOrigin, ownOrigin, getModule, timeoutMs = 8000, run = runInFrame,
  harnessOnBranch = true,
}) {
  const moduleUrl = `${previewOrigin}/blocks/${block}/${block}.js`;
  const cssUrl = `${previewOrigin}/blocks/${block}/${block}.css`;
  const base = {
    block, html, cssUrl, codeOrigin: previewOrigin,
  };
  const harness = '/tools/block-source/dryrun.html';
  const attempts = [
    { strategy: 'branch-origin', src: `${previewOrigin}${harness}`, payload: async () => ({ ...base, moduleUrl }) },
    { strategy: 'module-url', src: `${ownOrigin}${harness}`, payload: async () => ({ ...base, moduleUrl }) },
    {
      strategy: 'module-source',
      src: `${ownOrigin}${harness}`,
      payload: async () => {
        const mod = await getModule();
        return { ...base, moduleUrl: mod.moduleUrl, code: mod.code };
      },
    },
  ];
  if (!harnessOnBranch) attempts.shift();
  const tried = [];
  for (const attempt of attempts) {
    let payload;
    try {
      // eslint-disable-next-line no-await-in-loop
      payload = await attempt.payload();
    } catch (e) {
      tried.push({ strategy: attempt.strategy, error: e.message });
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await run({ src: attempt.src, payload, timeoutMs });
    if (!result.unavailable && result.phase !== 'import') {
      return { ...result, strategy: attempt.strategy, tried };
    }
    tried.push({ strategy: attempt.strategy, error: result.unavailable ? 'harness unavailable' : result.error });
  }
  return { ok: false, unavailable: true, tried };
}
