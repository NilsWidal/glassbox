import type { Calibrator } from '../types.js';
import { normalize } from './confidence.js';

const EPS = 1e-6;

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function logit(p: number): number {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
}

/**
 * Applies a fitted calibrator to a probability vector (option order kept).
 * For two options Platt maps the first option's p and sets the second to 1 - p';
 * with more options it maps each one-vs-rest and renormalizes.
 */
export function applyCalibrator(probs: readonly number[], cal?: Calibrator): number[] {
  const p = normalize(probs);
  if (!cal || cal.kind === 'identity') return p;
  if (cal.kind === 'temperature') {
    if (!(cal.T > 0)) throw new RangeError('temperature T must be > 0');
    return normalize(p.map((v) => Math.pow(v, 1 / cal.T)));
  }
  const map = (v: number) => sigmoid(cal.a * logit(v) + cal.b);
  if (p.length === 2) {
    const first = map(p[0]!);
    return [first, 1 - first];
  }
  return normalize(p.map(map));
}
