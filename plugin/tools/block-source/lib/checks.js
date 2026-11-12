/**
 * Gate 3 evaluation and the author-language reasons.
 * The dry run fails only when authored content is lost: added text is fine,
 * fewer words, links or images than the author wrote is not.
 */

function lostWords(before, after) {
  const counts = new Map();
  after.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
  const lost = [];
  before.forEach((w) => {
    const n = counts.get(w) || 0;
    if (n > 0) counts.set(w, n - 1);
    else lost.push(w);
  });
  return lost;
}

const quote = (s) => `“${s}”`;

export function evaluateDryRun(result) {
  const reasons = [];
  if (!result) return { pass: false, reasons: [{ code: 'no-result', message: 'The check could not run.' }] };
  if (result.timedOut) {
    reasons.push({ code: 'timeout', message: 'The new code took too long to display your content.' });
  } else if (!result.ok) {
    reasons.push({
      code: 'error',
      message: 'The new code stopped with an error when it tried to display your content.',
      detail: result.error || null,
    });
  }
  if (result.before && result.after) {
    const lost = lostWords(result.before.words, result.after.words);
    if (lost.length) {
      const sample = [...new Set(lost)].slice(0, 5).map(quote).join(', ');
      reasons.push({
        code: 'text-lost',
        message: `Some of your text would not show (${lost.length} word${lost.length === 1 ? '' : 's'}, for example ${sample}).`,
        lost,
      });
    }
    if (result.after.links < result.before.links) {
      reasons.push({ code: 'links-lost', message: `Your content has ${result.before.links} links. Only ${result.after.links} would show.` });
    }
    if (result.after.images < result.before.images) {
      reasons.push({ code: 'images-lost', message: `Your content has ${result.before.images} images. Only ${result.after.images} would show.` });
    }
    if (result.ok && result.after.height === 0 && result.before.words.length) {
      reasons.push({ code: 'empty', message: 'The block would display as empty.' });
    }
  }
  return { pass: reasons.length === 0, reasons };
}

const ORD = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const num = (n) => ORD[n] || String(n);
const col = (n) => `${num(n)} column${n === 1 ? '' : 's'}`;

/** Turns gate 2 signature hints into sentences about the author's own content. */
export function hintMessages(hints = [], shape = null) {
  const out = [];
  hints.forEach((h) => {
    if (h.code === 'more-cells') {
      if (!shape || shape.maxCells < h.to) {
        out.push({
          code: h.code,
          message: shape
            ? `This version needs ${col(h.to)} in each row. Your content has ${num(shape.maxCells)}.`
            : `This version needs ${col(h.to)} in each row.`,
        });
      }
    } else if (h.code === 'more-rows') {
      if (!shape || shape.rows < h.to) {
        out.push({
          code: h.code,
          message: shape
            ? `This version reads at least ${num(h.to)} rows. Your content has ${num(shape.rows)}.`
            : `This version reads at least ${num(h.to)} rows.`,
        });
      }
    } else if (h.code === 'new-variant') {
      out.push({ code: h.code, message: `This version adds the ${quote(h.variant)} option.`, info: true });
    }
  });
  return out;
}

/** Final verdict for the author, from the broker gates and the optional dry run. */
export function combineVerdict(compat, dryRun, shape) {
  const hints = hintMessages(compat.hints, shape);
  if (compat.verdict === 'blocked') {
    return { verdict: 'blocked', decidedBy: compat.decidedBy, reasons: [...compat.reasons, ...hints.filter((h) => !h.info)] };
  }
  if (compat.verdict === 'safe') return { verdict: 'safe', decidedBy: compat.decidedBy, reasons: compat.reasons, notes: hints.filter((h) => h.info) };
  if (!dryRun) return { verdict: 'unknown', decidedBy: null, reasons: [{ code: 'no-dry-run', message: 'This version changes the block code, and the check with your content could not run.' }] };
  const evaluation = evaluateDryRun(dryRun);
  if (evaluation.pass) {
    return {
      verdict: 'safe', decidedBy: 'gate3', reasons: [{ code: 'dry-run-passed', message: 'The new code displayed all of your content.' }], notes: hints.filter((h) => h.info),
    };
  }
  return { verdict: 'blocked', decidedBy: 'gate3', reasons: [...evaluation.reasons, ...hints.filter((h) => !h.info)] };
}

export async function hashKey(...parts) {
  const data = new TextEncoder().encode(parts.join('\u0000'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
