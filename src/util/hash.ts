import { createHash } from 'node:crypto';
import type { State } from '../types.js';
import { stableStringify } from './json.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Text form of a state as it appears in prompts. */
export function stateText(state: State): string {
  return typeof state === 'string' ? state : stableStringify(state, 2);
}

export function hashState(state: State): string {
  return sha256(stateText(state));
}

/** 32-bit FNV-1a, for cheap deterministic seeds. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32) returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
