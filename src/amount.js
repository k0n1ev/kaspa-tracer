/** Monetary values are integer sompi, never floating-point KAS. */
export const SOMPI = 100_000_000n;

export function sompi(value, field = 'amount') {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Invalid or unsafe ${field}; expected nonnegative integer sompi`);
}

/** Preserve large JSON integer literals before JSON.parse can round them. */
export function parseLosslessJSON(text) {
  let result = '', i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i++] === '"') break;
      }
      result += text.slice(start, i);
    } else if (text[i] === '-' || /[0-9]/.test(text[i])) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!match) throw new SyntaxError('Invalid JSON number');
      const token = match[0];
      const integer = !/[.eE]/.test(token);
      result += integer && (BigInt(token) > 9007199254740991n || BigInt(token) < -9007199254740991n)
        ? `"${token}"` : token;
      i += token.length;
    } else result += text[i++];
  }
  return JSON.parse(result);
}

/** Largest-remainder proportional attribution; exact conservation at each split.
 * A transaction does not identify a unique input-to-output ownership mapping.
 * This allocation is an explicit model, not a claim about individual coins.
 */
export function allocate(total, weights) {
  total = sompi(total);
  weights = weights.map(w => sompi(w));
  const denominator = weights.reduce((s, w) => s + w, 0n);
  if (!denominator) {
    if (!total) return weights.map(() => 0n);
    throw new Error('Cannot allocate over zero-valued inputs');
  }
  const shares = weights.map(w => total * w / denominator);
  let remainder = total - shares.reduce((s, w) => s + w, 0n);
  const order = weights.map((w, i) => ({i, r: total * w % denominator}))
    .sort((a, b) => a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1);
  for (const {i} of order) { if (!remainder) break; shares[i]++; remainder--; }
  return shares;
}

export function formatKAS(value, places = 8) {
  const n = sompi(value);
  const whole = (n / SOMPI).toLocaleString('en-US');
  const fraction = (n % SOMPI).toString().padStart(8, '0').slice(0, places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
export function kasDecimal(value) {
  const n = sompi(value);
  return `${n / SOMPI}.${(n % SOMPI).toString().padStart(8, '0')}`;
}
export function percent(value, total) {
  return total > 0n ? Number(value * 1_000_000n / total) / 10_000 : 0;
}
export function stringify(value, space = 2) {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, space);
}

/** Monotone cumulative apportionment (Jefferson / highest averages).
 * Unlike largest-remainder rounding, increasing the total never takes a unit
 * away from an input. Pooling by transaction prevents sibling outputs from
 * repeatedly rounding the same one-sompi input upward. At total=sum(weights),
 * every input receives exactly its value.
 */
export function apportion(total, weights) {
  total = sompi(total); weights = weights.map(w => sompi(w));
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (!sum) {
    if (!total) return weights.map(() => 0n);
    throw new Error('Cannot apportion to zero inputs');
  }
  const shares = weights.map(w => total * w / sum);
  let left = total - shares.reduce((s, w) => s + w, 0n);
  const heap = weights.map((_, i) => i).filter(i => weights[i] > 0n);
  const better = (i, j) => {
    const a = weights[i] * (shares[j] + 1n), b = weights[j] * (shares[i] + 1n);
    return a === b ? i < j : a > b;
  };
  const down = start => {
    let i = start;
    while (true) {
      let best = i, a = 2 * i + 1, b = a + 1;
      if (a < heap.length && better(heap[a], heap[best])) best = a;
      if (b < heap.length && better(heap[b], heap[best])) best = b;
      if (best === i) break;
      [heap[i], heap[best]] = [heap[best], heap[i]]; i = best;
    }
  };
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);
  while (left > 0n) { shares[heap[0]]++; left--; down(0); }
  return shares;
}
