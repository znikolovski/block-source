/**
 * Talks to the canvas agent (agent.js, loaded by the site inside the Experience Workspace canvas).
 *
 * The plugin cannot find the canvas window: both frames live in shadow DOM, which window.frames
 * does not expose. Instead the agent opens bridge.html from the plugin's own origin inside the
 * canvas, and the plugin and the bridge share a BroadcastChannel. Browsers partition the channel
 * by top-level site, so only frames of this origin under the same Experience Workspace page can
 * join. Messages carry a per-tab ID kept in sessionStorage, so a second tab is never driven.
 */

export const CHANNEL = 'block-source:canvas';
export const TAB_KEY = 'block-source:tab';
const CALL_TIMEOUT = 30000;
const HELLO_TIMEOUT = 1500;

export function tabId(storage) {
  let id = storage.getItem(TAB_KEY);
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem(TAB_KEY, id);
  }
  return id;
}

function channelClient({ org, site, tab }, createChannel) {
  const channel = createChannel(CHANNEL);
  const pending = new Map();
  channel.onmessage = ({ data }) => {
    if (!data || data.type !== 'block-source:agent-reply' || data.tab !== tab) return;
    const call = pending.get(data.id);
    if (!call) return;
    // The agent reports the site it runs on; ignore a canvas of another site.
    if (data.org !== org || data.site !== site) return;
    pending.delete(data.id);
    clearTimeout(call.timer);
    if (data.ok) call.resolve(data.result === undefined ? data : data.result);
    else call.reject(Object.assign(new Error(data.error), { phase: data.phase }));
  };
  const call = (type, args, timeoutMs = CALL_TIMEOUT) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('The canvas did not answer.'), { phase: 'connect' }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    channel.postMessage({
      type, id, tab, org, site, args,
    });
  });
  return { call, close: () => channel.close() };
}

export async function connectCanvas({ org, site }, {
  storage = window.sessionStorage,
  createChannel = (name) => new BroadcastChannel(name),
  helloTimeout = HELLO_TIMEOUT,
} = {}) {
  let tab;
  try {
    tab = tabId(storage);
  } catch {
    return null;
  }
  const client = channelClient({ org, site, tab }, createChannel);
  try {
    const hello = await client.call('block-source:agent-hello', null, helloTimeout);
    return {
      mode: 'channel',
      path: hello.path,
      agent: {
        apply: (args) => client.call('block-source:agent-apply', args),
        revert: (id) => client.call('block-source:agent-revert', { id }),
        revertAll: () => client.call('block-source:agent-revert-all'),
        list: () => client.call('block-source:agent-list'),
        capture: (args) => client.call('block-source:agent-capture', args, 25000),
      },
      close: client.close,
    };
  } catch {
    client.close();
    return null;
  }
}
