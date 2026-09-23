import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDecisionLog, readDecisionLog } from '../../src/ask.js';
import {
  calibrateFromLog,
  calibratorsFor,
  decisionLogPath,
  fitFromRecords,
  labelDecision,
  loadCalibration,
  loadCalibrators,
  normalizeTruth,
  recordSample,
} from '../../src/calibrate/store.js';
import { calibratorsForQuestion } from '../../src/engine/questions.js';
import type { DecisionRecord, Question } from '../../src/types.js';

const yesno: Question = { type: 'yesno', instructions: 'q?' };

function rec(id: string, pTrue: number, extra: Partial<DecisionRecord> = {}): DecisionRecord {
  const raw = { true: pTrue, false: 1 - pTrue };
  return {
    id,
    ts: '2026-01-01T00:00:00.000Z',
    stateHash: 'h',
    questionId: 'q',
    question: yesno,
    backend: 'claude-cli',
    model: 'haiku',
    raw,
    calibrated: raw,
    answer: { type: 'yesno', p: pTrue, confidence: Math.abs(2 * pTrue - 1), band: 'confirm' },
    permutations: 2,
    latencyMs: 1,
    ...extra,
  };
}

describe('labels and the calibration store', () => {
  it('normalizes answers per question type', () => {
    expect(normalizeTruth(yesno, 'YES')).toBe('true');
    expect(normalizeTruth(yesno, 'n')).toBe('false');
    expect(normalizeTruth({ type: 'choice', instructions: 'x', criteria: { Fast: '', slow: '' } }, 'fast')).toBe('Fast');
    const score: Question = { type: 'score', instructions: 'x', criteria: ['none', 'low', 'high'] };
    expect(normalizeTruth(score, '2')).toBe('2');
    expect(normalizeTruth(score, 'Low')).toBe('1');
    expect(() => normalizeTruth(yesno, 'maybe')).toThrow(/not an option/);
  });

  it('labels a decision by id prefix and rewrites the log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glassbox-cal-'));
    const log = decisionLogPath(root);
    await appendDecisionLog(log, rec('abc123def456', 0.8));
    await appendDecisionLog(log, rec('ffff00001111', 0.3));
    const r = await labelDecision(root, 'abc1', 'no');
    expect(r).toMatchObject({ id: 'abc123def456', truth: 'false', predicted: 'true' });
    const records = await readDecisionLog(log);
    expect(records.map((x) => x.truth)).toEqual(['false', undefined]);
    await expect(labelDecision(root, 'zzz', 'yes')).rejects.toThrow(/no logged decision/);
  });

  it('refuses an ambiguous prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glassbox-cal-'));
    await appendDecisionLog(decisionLogPath(root), rec('aa1', 0.5));
    await appendDecisionLog(decisionLogPath(root), rec('aa2', 0.5));
    await expect(labelDecision(root, 'aa', 'yes')).rejects.toThrow(/matches 2/);
  });

  it('reads truth or a label field into samples over raw probabilities', () => {
    expect(recordSample(rec('a', 0.75, { truth: 'true' }))).toEqual({ probs: [0.75, 0.25], truth: 0 });
    expect(recordSample({ ...rec('b', 0.75), label: 'false' } as DecisionRecord)).toEqual({ probs: [0.75, 0.25], truth: 1 });
    expect(recordSample(rec('c', 0.9))).toBeUndefined();
  });

  it('fits one calibrator per (questionId, backend, model)', () => {
    const records: DecisionRecord[] = [];
    for (let i = 0; i < 20; i++) {
      // Always says 0.95 but is right only 60% of the time: overconfident.
      records.push(rec(`a${i}`, 0.95, { truth: i % 5 < 3 ? 'true' : 'false' }));
      records.push(rec(`b${i}`, 0.95, { truth: 'true', model: 'sonnet' }));
    }
    records.push(rec('c', 0.5, { truth: 'true', backend: 'codex-cli', model: undefined }));
    const r = fitFromRecords(records);
    expect(r.labeled).toBe(41);
    const haiku = r.entries.find((e) => e.model === 'haiku')!;
    expect(haiku.n).toBe(20);
    expect(haiku.calibrator.kind).toBe('temperature');
    expect(haiku.after.nll).toBeLessThan(haiku.before.nll);
    expect(r.entries.find((e) => e.backend === 'codex-cli')!.calibrator).toEqual({ kind: 'identity' });
  });

  it('saves calibration.json and loads the calibrators for a backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glassbox-cal-'));
    for (let i = 0; i < 10; i++) await appendDecisionLog(decisionLogPath(root), rec(`r${i}`, 0.9, { truth: i < 6 ? 'true' : 'false' }));
    const r = await calibrateFromLog(root);
    expect(r.file).toBe(join(root, '.glassbox', 'calibration.json'));
    const file = await loadCalibration(root);
    expect(file?.entries).toHaveLength(1);
    expect(JSON.parse(await readFile(r.file!, 'utf8')).entries[0].beforeBins).toBeUndefined();
    const cals = await loadCalibrators(root, { name: 'claude-cli', model: 'haiku' });
    expect(cals['ask:yesno']?.kind).toBe('temperature');
    expect(calibratorsFor(file, 'claude-cli', 'sonnet')).toEqual({});
    expect(await loadCalibrators(join(root, 'missing'), { name: 'claude-cli', model: 'haiku' })).toEqual({});
  });

  it('keeps yes/no, choice and score asks in separate calibration groups', () => {
    const choice3: Question = { type: 'choice', instructions: 'which?', criteria: { a: '', b: '', c: '' } };
    const recs = [
      ...Array.from({ length: 5 }, (_, i) => rec(`y${i}`, 0.9, { truth: 'true' })),
      ...Array.from({ length: 5 }, (_, i) => ({ ...rec(`c${i}`, 0.9, { truth: 'a' }), question: choice3, raw: { a: 0.8, b: 0.1, c: 0.1 }, calibrated: { a: 0.8, b: 0.1, c: 0.1 } })),
    ];
    const keys = fitFromRecords(recs as DecisionRecord[]).entries.map((e) => e.questionId).sort();
    expect(keys).toEqual(['ask:choice:3', 'ask:yesno']);
    expect(calibratorsForQuestion({ 'ask:yesno': { kind: 'temperature', T: 2 } }, 'q', choice3)).toEqual({});
    expect(calibratorsForQuestion({ 'ask:yesno': { kind: 'temperature', T: 2 } }, 'q', yesno)).toEqual({ q: { kind: 'temperature', T: 2 } });
  });

  it('dry run writes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glassbox-cal-'));
    for (let i = 0; i < 10; i++) await appendDecisionLog(decisionLogPath(root), rec(`r${i}`, 0.9, { truth: 'true' }));
    const r = await calibrateFromLog(root, { dryRun: true });
    expect(r.file).toBeUndefined();
    expect(await loadCalibration(root)).toBeUndefined();
  });
});
