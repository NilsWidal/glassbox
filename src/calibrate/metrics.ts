import { argmax, normalize } from '../engine/confidence.js';

/** One scored prediction: probabilities in canonical option order and the index of the true option. */
export interface Sample {
  probs: number[];
  truth: number;
}

export interface ReliabilityBin {
  /** Bin range over top-label probability, [lo, hi). The last bin includes 1. */
  lo: number;
  hi: number;
  count: number;
  /** Mean top-label probability of the samples in the bin. */
  meanP: number;
  /** Share of samples in the bin whose top option was the true one. */
  accuracy: number;
}

export interface Metrics {
  n: number;
  accuracy: number;
  /** Expected calibration error over top-label probability, equal-width bins. */
  ece: number;
  /** Multi-class Brier score: sum over options of (p - y)^2, averaged. Range 0 to 2. */
  brier: number;
  /** Mean negative log-likelihood of the true option. */
  nll: number;
  bins: ReliabilityBin[];
}

export const ECE_BINS = 15;
const EPS = 1e-12;

function binOf(p: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
}

/** Accuracy, ECE (15 bins by default), Brier and NLL. Empty input gives NaN scores. */
export function computeMetrics(samples: readonly Sample[], bins = ECE_BINS): Metrics {
  const table = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, count: 0, sumP: 0, correct: 0 }));
  let correct = 0;
  let brier = 0;
  let nll = 0;
  for (const s of samples) {
    const p = normalize(s.probs);
    const top = argmax(p);
    const pmax = p[top]!;
    const hit = top === s.truth ? 1 : 0;
    correct += hit;
    brier += p.reduce((acc, v, k) => acc + (v - (k === s.truth ? 1 : 0)) ** 2, 0);
    nll -= Math.log(Math.max(EPS, p[s.truth] ?? 0));
    const b = table[binOf(pmax, bins)]!;
    b.count++;
    b.sumP += pmax;
    b.correct += hit;
  }
  const n = samples.length;
  const out: ReliabilityBin[] = table.map((b) => ({
    lo: b.lo,
    hi: b.hi,
    count: b.count,
    meanP: b.count ? b.sumP / b.count : NaN,
    accuracy: b.count ? b.correct / b.count : NaN,
  }));
  const ece = n ? out.reduce((acc, b) => acc + (b.count ? (b.count / n) * Math.abs(b.accuracy - b.meanP) : 0), 0) : NaN;
  return { n, accuracy: n ? correct / n : NaN, ece, brier: n ? brier / n : NaN, nll: n ? nll / n : NaN, bins: out };
}

function fmt(x: number, digits = 3): string {
  return Number.isFinite(x) ? x.toFixed(digits) : '-';
}

/**
 * ASCII reliability table: one row per non-empty bin, with a bar of accuracy
 * and a `|` at the mean predicted probability. On a calibrated model the bar
 * ends at the marker.
 */
export function reliabilityTable(m: Metrics, width = 20): string {
  const lines = ['bin          n    mean p  acc    gap     accuracy vs mean p (|)'];
  for (const b of m.bins) {
    if (!b.count) continue;
    const filled = Math.round(b.accuracy * width);
    const mark = Math.min(width - 1, Math.round(b.meanP * width));
    const bar = Array.from({ length: width }, (_, i) => (i === mark ? '|' : i < filled ? '#' : '.')).join('');
    lines.push(
      `${fmt(b.lo, 2)}-${fmt(b.hi, 2)}  ${String(b.count).padStart(4)}  ${fmt(b.meanP)}   ${fmt(b.accuracy)}  ${(b.accuracy - b.meanP >= 0 ? '+' : '') + fmt(b.accuracy - b.meanP)}  ${bar}`,
    );
  }
  return lines.join('\n');
}

/** One-line summary, e.g. "n=60 acc=0.850 ECE=0.071 Brier=0.214". */
export function metricsLine(m: Metrics): string {
  return `n=${m.n} acc=${fmt(m.accuracy)} ECE=${fmt(m.ece)} Brier=${fmt(m.brier)} NLL=${fmt(m.nll)}`;
}

/** q-th percentile (0 to 100) by linear interpolation; NaN when empty. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (Math.min(100, Math.max(0, q)) / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
