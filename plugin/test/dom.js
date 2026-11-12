import { JSDOM } from 'jsdom';

/** Installs a jsdom window as the global browser environment. */
export function installDom(html = '<!DOCTYPE html><html><head></head><body><main></main></body></html>', url = 'https://main--site--acme.aem.page/') {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  const g = globalThis;
  g.window = window;
  g.document = window.document;
  g.Node = window.Node;
  g.DOMParser = window.DOMParser;
  g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  g.CSS = window.CSS;
  return window;
}
