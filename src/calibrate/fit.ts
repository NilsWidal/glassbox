import { applyCalibrator, logit, sigmoid } from '../engine/calibrate.js';
import type { Calibrator } from '../types.js';
import type { Sample } from './metrics.js';

export type FitMethod = 'auto' | 'temperature' | 'platt';

/** Below this many labels nothing is fitted (identity). */
export const MIN_LABELS = 8;
/** `auto` picks Platt (two parameters) only for binary groups with at least this many labels. */
export const MIN_PLATT_LABELS = 30;

const T_MIN = 0.05;
const T_MAX = 20;

function nll(samples: readonly Sample[], cal: Calibrator): number {
  let total = 0;
  for (const s of samples) total -= Math.log(Math.max(1e-12, applyCalibrator(s.probs, cal)[s.truth] ?? 0));
  return total / Math.max(1, samples.length);
}

/**
 * Temperature scaling: the T that minimizes NLL of p^(1/T), renormalized
 * (the engine's temperature calibrator). Golden-section search over log T.
 */
export function fitTemperature(samples: readonly Sample[]): Calibrator & { kind: 'temperature' } {
  if (samples.length === 0) return { kind: 'temperature', T: 1 };
  const f = (logT: number) => nll(samples, { kind: 'temperature', T: Math.exp(logT) });
  let lo = Math.log(T_MIN);
  let hi = Math.log(T_MAX);
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let i = 0; i < 80 && hi - lo > 1e-6; i++) {
    if (f1 <= f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = f(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = f(x2);
    }
  }
  return { kind: 'temperature', T: round(Math.exp((lo + hi) / 2)) };
}

/**
 * Platt scaling for two-option questions: sigmoid(a * logit(p_first) + b),
 * fitted by Newton's method with Platt's smoothed targets and a small pull
 * toward the identity (a = 1, b = 0) so few labels cannot run away.
 */
export function fitPlatt(samples: readonly Sample[], lambda = 0.01): Calibrator & { kind: 'platt' } {
  if (samples.some((s) => s.probs.length !== 2)) throw new RangeError('Platt scaling needs two-option samples');
  const pos = samples.filter((s) => s.truth === 0).length;
  const neg = samples.length - pos;
  const tPos = (pos + 1) / (pos + 2);
  const tNeg = 1 / (neg + 2);
  const xs = samples.map((s) => logit(s.probs[0]! / (s.probs[0]! + s.probs[1]! || 1)));
  const ts = samples.map((s) => (s.truth === 0 ? tPos : tNeg));
  let a = 1;
  let b = 0;
  for (let it = 0; it < 100; it++) {
    // Gradient and Hessian of mean cross-entropy plus lambda * ((a-1)^2 + b^2).
    let ga = 2 * lambda * (a - 1);
    let gb = 2 * lambda * b;
    let haa = 2 * lambda;
    let hab = 0;
    let hbb = 2 * lambda;
    const n = Math.max(1, xs.length);
    xs.forEach((x, i) => {
      const p = sigmoid(a * x + b);
      const d = (p - ts[i]!) / n;
      const w = (p * (1 - p)) / n;
      ga += d * x;
      gb += d;
      haa += w * x * x;
      hab += w * x;
      hbb += w;
    });
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { kind: 'platt', a: round(a), b: round(b) };
}

/** Fits one calibrator for a group of samples, or identity when there are too few labels. */
export function fitCalibrator(samples: readonly Sample[], method: FitMethod = 'auto', minLabels = MIN_LABELS): Calibrator {
  if (samples.length < minLabels) return { kind: 'identity' };
  const binary = samples.every((s) => s.probs.length === 2);
  if (method === 'platt') {
    if (!binary) throw new RangeError('Platt scaling needs two-option questions; use --method temperature');
    return fitPlatt(samples);
  }
  if (method === 'auto' && binary && samples.length >= MIN_PLATT_LABELS) return fitPlatt(samples);
  return fitTemperature(samples);
}

/** Applies a calibrator to every sample (for before/after metrics). */
export function calibrateSamples(samples: readonly Sample[], cal: Calibrator): Sample[] {
  return samples.map((s) => ({ probs: applyCalibrator(s.probs, cal), truth: s.truth }));
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
