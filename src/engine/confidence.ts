/** Coerces to a probability vector: negatives and NaN become 0; all-zero becomes uniform. */
export function normalize(values: readonly number[]): number[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  if (sum <= 0) return clean.map(() => 1 / (clean.length || 1));
  return clean.map((v) => v / sum);
}

/** Index of the largest value (first on ties). */
export function argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  return best;
}

/**
 * Confidence = (K * pmax - 1) / (K - 1): 0 for a uniform distribution, 1 when
 * one option has all the mass. Our own documented definition.
 */
export function confidence(probs: readonly number[]): number {
  const k = probs.length;
  if (k < 2) return 1;
  const pmax = Math.max(...probs);
  return clamp01((k * pmax - 1) / (k - 1));
}

/** Probability-weighted expected level; probs[i] is P(level i). */
export function expectedScore(probs: readonly number[]): number {
  return probs.reduce((acc, p, i) => acc + p * i, 0);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
