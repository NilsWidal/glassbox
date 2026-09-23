import { describe, expect, it } from 'vitest';
import { FakeBackend, batchForPermutation, fixedAnswer, whenContains } from '../src/index.js';
import type { Question } from '../src/index.js';

const q: Record<string, Question> = {
  a: { type: 'yesno', instructions: 'Touches the database?' },
  b: { type: 'choice', instructions: 'Kind?', criteria: { x: '', y: '', z: '' } },
};

describe('FakeBackend', () => {
  it('is deterministic for the same state and questions', async () => {
    const f1 = new FakeBackend({ seed: 7 });
    const f2 = new FakeBackend({ seed: 7 });
    const batch = batchForPermutation(q, 0, 0);
    expect(await f1.answerBatch('state', batch)).toEqual(await f2.answerBatch('state', batch));
  });

  it('changes with the seed and the state', async () => {
    const batch = batchForPermutation(q, 0, 0);
    const base = await new FakeBackend({ seed: 1 }).answerBatch('state', batch);
    expect(await new FakeBackend({ seed: 2 }).answerBatch('state', batch)).not.toEqual(base);
    expect(await new FakeBackend({ seed: 1 }).answerBatch('other state', batch)).not.toEqual(base);
  });

  it('returns normalized label distributions', async () => {
    const out = await new FakeBackend().answerBatch('s', batchForPermutation(q, 0, 0));
    for (const dist of Object.values(out)) {
      expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    expect(Object.keys(out.b!)).toEqual(['A', 'B', 'C']);
  });

  it('keeps the same answer by option when the display order changes', async () => {
    const f = new FakeBackend({ seed: 3 });
    const fwd = await f.answerBatch('s', batchForPermutation(q, 0, 0));
    const rev = await f.answerBatch('s', batchForPermutation(q, 1, 0));
    // yesno: A=true forward, B=true reversed
    expect(rev.a!.B).toBeCloseTo(fwd.a!.A!, 12);
  });

  it('applies rules: whenContains and fixedAnswer', async () => {
    const f = new FakeBackend({
      rules: [whenContains('db.query', 0.95, 0.05, 'a'), fixedAnswer('b', { z: 1 })],
    });
    const batch = batchForPermutation(q, 0, 0);
    const hit = await f.answerBatch('const r = db.query(sql)', batch);
    const miss = await f.answerBatch('const r = 1', batch);
    expect(hit.a!.A).toBeCloseTo(0.95);
    expect(miss.a!.A).toBeCloseTo(0.05);
    expect(hit.b).toEqual({ A: 0, B: 0, C: 1 });
  });

  it('rules see object states as text', async () => {
    const f = new FakeBackend({ rules: [whenContains('secret', 0.9, 0.1)] });
    const out = await f.answerBatch({ code: 'const secret = 1' }, batchForPermutation({ a: q.a! }, 0, 0));
    expect(out.a!.A).toBeCloseTo(0.9);
  });

  it('rejects numeric rule results for non-yesno questions', async () => {
    const f = new FakeBackend({ rules: [() => 0.5] });
    await expect(f.answerBatch('s', batchForPermutation({ b: q.b! }, 0, 0))).rejects.toThrow(/only for yesno/);
  });

  it('adds position bias to the first shown label', async () => {
    const f = new FakeBackend({ rules: [() => 0.5], positionBias: 1 });
    const out = await f.answerBatch('s', batchForPermutation({ a: q.a! }, 0, 0));
    expect(out.a!.A).toBeCloseTo(0.75);
  });

  it('records calls and supports scripted failures and generate', async () => {
    const f = new FakeBackend({ failCalls: [1], generate: (p) => `echo ${p}` });
    const batch = batchForPermutation(q, 0, 0);
    await f.answerBatch('s', batch);
    await expect(f.answerBatch('s', batch)).rejects.toThrow(/fake failure/);
    expect(f.calls).toHaveLength(2);
    expect(await f.generate('hi')).toBe('echo hi');
    expect(f.capabilities).toEqual({ hasLogprobs: true, batch: true, generate: true });
  });
});
