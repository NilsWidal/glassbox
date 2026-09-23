import { describe, expect, it } from 'vitest';
import { calibrateSamples, fitCalibrator, fitPlatt, fitTemperature } from '../../src/calibrate/fit.js';
import { computeMetrics, type Sample } from '../../src/calibrate/metrics.js';
import { seededRandom } from '../../src/util/hash.js';

/** Binary samples whose true P(first) is q, reported as `reported(q)`. */
function synth(n: number, reported: (q: number) => number, seed = 1): Sample[] {
  const rand = seededRandom(seed);
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const q = 0.05 + 0.9 * rand();
    const p = reported(q);
    out.push({ probs: [p, 1 - p], truth: rand() < q ? 0 : 1 });
  }
  return out;
}

const sharpen = (q: number) => {
  const a = q ** 3;
  return a / (a + (1 - q) ** 3);
};

describe('calibration fitting', () => {
  it('temperature softens an overconfident model (T > 1) and lowers ECE', () => {
    const s = synth(400, sharpen);
    const cal = fitTemperature(s);
    expect(cal.T).toBeGreaterThan(2);
    expect(computeMetrics(calibrateSamples(s, cal)).ece).toBeLessThan(computeMetrics(s).ece);
  });

  it('temperature sharpens an underconfident model (T < 1)', () => {
    const s = synth(400, (q) => 0.5 + (q - 0.5) * 0.3, 2);
    expect(fitTemperature(s).T).toBeLessThan(1);
  });

  it('Platt fixes a shifted model', () => {
    // Reports P(first) too high: the fitted b must be negative.
    const s = synth(400, (q) => Math.min(0.99, q + 0.2), 3);
    const cal = fitPlatt(s);
    expect(cal.b).toBeLessThan(0);
    expect(computeMetrics(calibrateSamples(s, cal)).nll).toBeLessThan(computeMetrics(s).nll);
  });

  it('stays near identity for a calibrated model', () => {
    const cal = fitTemperature(synth(2000, (q) => q, 4));
    expect(cal.T).toBeGreaterThan(0.8);
    expect(cal.T).toBeLessThan(1.25);
  });

  it('auto: identity below the label minimum, temperature for small or multi-class groups, Platt for large binary ones', () => {
    expect(fitCalibrator(synth(5, sharpen))).toEqual({ kind: 'identity' });
    expect(fitCalibrator(synth(12, sharpen)).kind).toBe('temperature');
    expect(fitCalibrator(synth(60, sharpen)).kind).toBe('platt');
    const multi: Sample[] = Array.from({ length: 40 }, (_, i) => ({ probs: [0.7, 0.2, 0.1], truth: i % 3 }));
    expect(fitCalibrator(multi).kind).toBe('temperature');
    expect(() => fitCalibrator(multi, 'platt')).toThrow(/two-option/);
    expect(fitCalibrator(synth(60, sharpen), 'temperature').kind).toBe('temperature');
  });
});
