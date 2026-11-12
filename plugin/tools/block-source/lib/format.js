const UNITS = [
  ['year', 365 * 86400], ['month', 30 * 86400], ['week', 7 * 86400], ['day', 86400], ['hour', 3600], ['minute', 60],
];

export function relativeTime(date, now = Date.now()) {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'just now';
  const [unit, size] = UNITS.find(([, n]) => s >= n);
  const n = Math.floor(s / size);
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

const SHORT = {
  year: 'y', month: 'mo', week: 'w', day: 'd', hour: 'h', minute: 'm',
};

/** A compact age for tight spaces: "4 mo", "3 d", "now". */
export function shortAge(date, now = Date.now()) {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'now';
  const [unit, size] = UNITS.find(([, n]) => s >= n);
  return `${Math.floor(s / size)} ${SHORT[unit] || unit}`;
}

export function formatDate(date) {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function personName(person) {
  if (!person) return 'Unknown';
  return person.name || person.login || 'Unknown';
}

/** Only https links (and http on localhost) are rendered as links. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.href;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.href;
  } catch {
    // not a URL
  }
  return null;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
