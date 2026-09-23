import { seededRandom } from '../util/hash.js';

/**
 * Index order for permutation number `p` of `n` options. p=0 is the
 * original order, p=1 reversed (so two passes put every option in a
 * mirrored position), p>=2 a seeded shuffle.
 */
export function permutationIndexes(n: number, p: number, seed = 0): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  if (p === 0) return idx;
  if (p === 1) return idx.reverse();
  const rand = seededRandom((seed ^ Math.imul(p, 0x9e3779b1)) >>> 0);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx;
}

export function permute<T>(items: readonly T[], p: number, seed = 0): T[] {
  return permutationIndexes(items.length, p, seed).map((i) => items[i]!);
}
