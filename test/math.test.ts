import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BANDS,
  applyCalibrator,
  argmax,
  bandFor,
  buildAnswer,
  confidence,
  expectedScore,
  logit,
  normalize,
  permutationIndexes,
  permute,
  resolveBands,
  sigmoid,
  winningOption,
} from '../src/index.js';

describe('normalize', () => {
  it('scales to sum 1', () => {
    expect(normalize([2, 6])).toEqual([0.25, 0.75]);
  });
  it('treats negatives and NaN as 0', () => {
    expect(normalize([-1, Number.NaN, 1])).toEqual([0, 0, 1]);
  });
  it('makes all-zero uniform', () => {
    expect(normalize([0, 0, 0, 0])).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

describe('confidence', () => {
  it('is 0 for uniform and 1 for certain', () => {
    expect(confidence([0.5, 0.5])).toBe(0);
    expect(confidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0, 12);
    expect(confidence([0, 1, 0])).toBe(1);
  });
  it('matches (K*pmax - 1)/(K - 1)', () => {
    expect(confidence([0.88, 0.12, 0])).toBeCloseTo(0.82, 10);
    expect(confidence([0.95, 0.05, 0])).toBeCloseTo(0.925, 10);
    expect(confidence([0.9, 0.1])).toBeCloseTo(0.8, 10);
  });
  it('argmax picks the first maximum', () => {
    expect(argmax([0.2, 0.4, 0.4])).toBe(1);
  });
});

describe('expectedScore', () => {
  it('weights levels by probability', () => {
    expect(expectedScore([0.15, 0.7, 0.15])).toBeCloseTo(1, 10);
    expect(expectedScore([0, 0, 1])).toBe(2);
    expect(expectedScore([0.5, 0.5])).toBe(0.5);
  });
});

describe('bands', () => {
  it('uses the default thresholds', () => {
    expect(DEFAULT_BANDS).toEqual({ act: 0.85, confirm: 0.6 });
    expect(bandFor(0.85)).toBe('act');
    expect(bandFor(0.849)).toBe('confirm');
    expect(bandFor(0.6)).toBe('confirm');
    expect(bandFor(0.59)).toBe('escalate');
  });
  it('question bands override defaults which override built-ins', () => {
    expect(resolveBands({ bands: { act: 0.95 } }, { act: 0.9, confirm: 0.5 })).toEqual({ act: 0.95, confirm: 0.5 });
    expect(resolveBands({}, { confirm: 0.7 })).toEqual({ act: 0.85, confirm: 0.7 });
    expect(resolveBands()).toEqual({ act: 0.85, confirm: 0.6 });
  });
});

describe('shuffle', () => {
  it('p=0 is identity and p=1 is reversed', () => {
    expect(permutationIndexes(4, 0)).toEqual([0, 1, 2, 3]);
    expect(permutationIndexes(4, 1)).toEqual([3, 2, 1, 0]);
  });
  it('p>=2 is a seeded, deterministic permutation', () => {
    const a = permutationIndexes(8, 2, 42);
    expect(permutationIndexes(8, 2, 42)).toEqual(a);
    expect([...a].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const others = [3, 4, 5, 6].map((p) => permutationIndexes(8, p, 42).join());
    expect(new Set([a.join(), ...others]).size).toBeGreaterThan(1);
  });
  it('permute applies the order', () => {
    expect(permute(['a', 'b', 'c'], 1)).toEqual(['c', 'b', 'a']);
  });
});

describe('calibration', () => {
  it('identity and missing calibrators only normalize', () => {
    expect(applyCalibrator([2, 2])).toEqual([0.5, 0.5]);
    expect(applyCalibrator([0.7, 0.3], { kind: 'identity' })).toEqual([0.7, 0.3]);
  });
  it('temperature > 1 softens and < 1 sharpens, keeping order', () => {
    const soft = applyCalibrator([0.8, 0.2], { kind: 'temperature', T: 2 });
    const sharp = applyCalibrator([0.8, 0.2], { kind: 'temperature', T: 0.5 });
    expect(soft[0]!).toBeLessThan(0.8);
    expect(soft[0]!).toBeGreaterThan(0.5);
    expect(sharp[0]!).toBeGreaterThan(0.8);
    expect(soft[0]! + soft[1]!).toBeCloseTo(1, 12);
    // p^(1/T) normalized: 0.8^0.5 / (0.8^0.5 + 0.2^0.5) = 2/3
    expect(soft[0]!).toBeCloseTo(2 / 3, 10);
  });
  it('temperature 1 is a no-op', () => {
    const p = applyCalibrator([0.6, 0.3, 0.1], { kind: 'temperature', T: 1 });
    expect(p[0]!).toBeCloseTo(0.6, 12);
    expect(p[2]!).toBeCloseTo(0.1, 12);
  });
  it('rejects non-positive temperature', () => {
    expect(() => applyCalibrator([0.5, 0.5], { kind: 'temperature', T: 0 })).toThrow(RangeError);
  });
  it('platt a=1 b=0 is identity for two options', () => {
    const p = applyCalibrator([0.73, 0.27], { kind: 'platt', a: 1, b: 0 });
    expect(p[0]!).toBeCloseTo(0.73, 5);
    expect(p[1]!).toBeCloseTo(0.27, 5);
  });
  it('platt maps binary p through sigmoid(a*logit(p)+b)', () => {
    const p = applyCalibrator([0.9, 0.1], { kind: 'platt', a: 0.5, b: -0.2 });
    expect(p[0]!).toBeCloseTo(sigmoid(0.5 * logit(0.9) - 0.2), 10);
    expect(p[0]! + p[1]!).toBeCloseTo(1, 12);
  });
  it('platt with more options stays a distribution', () => {
    const p = applyCalibrator([0.6, 0.3, 0.1], { kind: 'platt', a: 0.7, b: 0.1 });
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(argmax(p)).toBe(0);
  });
  it('logit clamps extremes', () => {
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
  });
});

describe('buildAnswer', () => {
  const bands = DEFAULT_BANDS;
  it('builds a yesno answer', () => {
    const a = buildAnswer({ type: 'yesno', instructions: 'x' }, [0.95, 0.05], bands);
    expect(a).toMatchObject({ type: 'yesno', band: 'act' });
    if (a.type !== 'yesno') throw new Error();
    expect(a.p).toBeCloseTo(0.95);
    expect(a.confidence).toBeCloseTo(0.9);
    expect(winningOption(a)).toBe('true');
  });
  it('builds a choice answer', () => {
    const a = buildAnswer({ type: 'choice', instructions: 'x', criteria: { a: '', b: '', c: '' } }, [0.1, 0.7, 0.2], bands);
    if (a.type !== 'choice') throw new Error();
    expect(a.choice).toBe('b');
    expect(a.probabilities).toEqual({ a: 0.1, b: 0.7, c: 0.2 });
    expect(a.confidence).toBeCloseTo(0.55);
    expect(a.band).toBe('escalate');
    expect(winningOption(a)).toBe('b');
  });
  it('builds a score answer with legend and expected level', () => {
    const a = buildAnswer({ type: 'score', instructions: 'x', criteria: ['calm', 'tense', 'angry'] }, [0.15, 0.7, 0.15], bands);
    if (a.type !== 'score') throw new Error();
    expect(a.score).toBeCloseTo(1);
    expect(a.legend).toEqual({ '0': 'calm', '1': 'tense', '2': 'angry' });
    expect(a.probabilities).toEqual({ '0': 0.15, '1': 0.7, '2': 0.15 });
    expect(winningOption(a)).toBe('1');
  });
  it('rejects a wrong-length vector', () => {
    expect(() => buildAnswer({ type: 'yesno', instructions: 'x' }, [1, 0, 0], bands)).toThrow(RangeError);
  });
});
