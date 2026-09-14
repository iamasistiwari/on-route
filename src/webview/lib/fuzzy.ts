// Typo tolerance for search and variable names. Pure; no DOM.

/** Optimal string alignment distance (insert, delete, substitute, swap neighbours); stops early above `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prevPrev[j - 2] + 1);
      cur.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** Typos allowed for a word of this length: none below 4 characters, one up to 7, then two. */
export function typoBudget(length: number): number {
  return length < 4 ? 0 : length < 8 ? 1 : 2;
}

/** `token` is a misspelling of `word`, or of its start (for words still being typed). */
export function isTypoOf(token: string, word: string): boolean {
  const max = typoBudget(token.length);
  if (max === 0) return false;
  return editDistance(token, word, max) <= max || (word.length > token.length && editDistance(token, word.slice(0, token.length), max) <= max);
}

/** The candidate closest to `name` within its typo budget (case-insensitive), or undefined. */
export function closestMatch(name: string, candidates: Iterable<string>): string | undefined {
  const n = name.toLowerCase();
  const max = typoBudget(n.length);
  if (max === 0) return undefined;
  let best: string | undefined;
  let bestDistance = max + 1;
  for (const c of candidates) {
    if (c === name) continue;
    const d = editDistance(n, c.toLowerCase(), max);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}
