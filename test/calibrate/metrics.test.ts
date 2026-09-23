import { describe, expect, it } from 'vitest';
import { computeMetrics, percentile, reliabilityTable } from '../../src/calibrate/metrics.js';

describe('calibration metrics', () => {
  it('scores perfect, confident predictions as calibrated', () => {
    const m = computeMetrics([
      { probs: [1, 0], truth: 0 },
      { probs: [0, 1], truth: 1 },
      { probs: [0, 0, 1], truth: 2 },
    ]);
    expect(m.n).toBe(3);
    expect(m.accuracy).toBe(1);
    expect(m.ece).toBeCloseTo(0, 10);
    expect(m.brier).toBeCloseTo(0, 10);
  });

  it('computes Brier, NLL and ECE by hand', () => {
    // Two samples, both p=0.8 on option 0; one right, one wrong.
    const m = computeMetrics([
      { probs: [0.8, 0.2], truth: 0 },
      { probs: [0.8, 0.2], truth: 1 },
    ]);
    expect(m.accuracy).toBe(0.5);
    // Brier: (0.04 + 0.04 + 0.64 + 0.64) / 2 = 0.68
    expect(m.brier).toBeCloseTo(0.68, 10);
    expect(m.nll).toBeCloseTo((-Math.log(0.8) - Math.log(0.2)) / 2, 10);
    // One bin holding both: |0.5 - 0.8| = 0.3
    expect(m.ece).toBeCloseTo(0.3, 10);
    expect(m.bins.filter((b) => b.count > 0)).toHaveLength(1);
    expect(m.bins).toHaveLength(15);
  });

  it('normalizes probabilities and puts p=1 in the last bin', () => {
    const m = computeMetrics([{ probs: [2, 0], truth: 0 }]);
    expect(m.bins[14]!.count).toBe(1);
    expect(m.brier).toBeCloseTo(0, 10);
  });

  it('gives NaN scores for no samples', () => {
    const m = computeMetrics([]);
    expect(m.n).toBe(0);
    expect(Number.isNaN(m.ece)).toBe(true);
  });

  it('renders an ASCII reliability table of non-empty bins', () => {
    const t = reliabilityTable(computeMetrics([{ probs: [0.9, 0.1], truth: 0 }, { probs: [0.6, 0.4], truth: 1 }]));
    const rows = t.split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('0.60-0.67');
    expect(rows[2]).toContain('0.87-0.93');
    expect(t).toContain('|');
  });

  it('percentile interpolates', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5);
    expect(percentile([5], 95)).toBe(5);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});
