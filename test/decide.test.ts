import { describe, expect, it } from 'vitest';
import { FakeBackend, QuestionError, decide, hashState, whenContains } from '../src/index.js';
import type { Backend, Question } from '../src/index.js';

const questions: Record<string, Question> = {
  auth: { type: 'yesno', instructions: 'Does this change auth behavior?' },
  area: { type: 'choice', instructions: 'Which area?', criteria: { billing: '', auth: '', other: '' } },
  risk: { type: 'score', instructions: 'How risky?', criteria: ['low', 'medium', 'high'] },
};

describe('decide', () => {
  it('makes one batched call per permutation, in parallel', async () => {
    const fake = new FakeBackend({ delayMs: 80 });
    const t0 = performance.now();
    const res = await decide('state', questions, fake);
    const elapsed = performance.now() - t0;
    expect(fake.calls).toHaveLength(2);
    expect(res.calls).toBe(2);
    expect(Object.keys(fake.calls[0]!.questions)).toEqual(['auth', 'area', 'risk']);
    expect(elapsed).toBeLessThan(150); // serial would take 160ms
  });

  it('makes exactly one call with permutations: 1', async () => {
    const fake = new FakeBackend();
    await decide('state', questions, fake, { permutations: 1 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.questions.auth!.options).toEqual(['true', 'false']);
  });

  it('uses mirrored option orders across the two default permutations', async () => {
    const fake = new FakeBackend();
    await decide('state', questions, fake);
    expect(fake.calls[0]!.questions.area!.options).toEqual(['billing', 'auth', 'other']);
    expect(fake.calls[1]!.questions.area!.options).toEqual(['other', 'auth', 'billing']);
  });

  it('falls back to one call per question when the backend cannot batch', async () => {
    const fake = new FakeBackend({ batch: false });
    const res = await decide('state', questions, fake);
    expect(fake.calls).toHaveLength(6);
    expect(res.calls).toBe(6);
    for (const c of fake.calls) expect(Object.keys(c.questions)).toHaveLength(1);
  });

  it('returns typed answers of each kind', async () => {
    const res = await decide('state', questions, new FakeBackend({ seed: 5 }));
    expect(res.answers.auth!.type).toBe('yesno');
    expect(res.answers.area!.type).toBe('choice');
    expect(res.answers.risk!.type).toBe('score');
    const area = res.answers.area!;
    if (area.type !== 'choice') throw new Error();
    expect(Object.values(area.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(['billing', 'auth', 'other']).toContain(area.choice);
  });

  it('cancels a first-position bias for two options by averaging mirrored orders', async () => {
    const fake = new FakeBackend({ rules: [() => ({ true: 0.5, false: 0.5 })], positionBias: 0.6 });
    const biased = await decide('s', { q: questions.auth! }, fake, { permutations: 1 });
    const fixed = await decide('s', { q: questions.auth! }, fake);
    if (biased.answers.q!.type !== 'yesno' || fixed.answers.q!.type !== 'yesno') throw new Error();
    expect(biased.answers.q!.p).toBeGreaterThan(0.6);
    expect(fixed.answers.q!.p).toBeCloseTo(0.5, 10);
  });

  it('reduces first-position bias for many options with more permutations', async () => {
    const q: Question = { type: 'choice', instructions: 'Pick', criteria: { a: '', b: '', c: '', d: '' } };
    const fake = new FakeBackend({ rules: [() => ({ a: 1, b: 1, c: 1, d: 1 })], positionBias: 1 });
    const one = await decide('s', { q }, fake, { permutations: 1 });
    const many = await decide('s', { q }, fake, { permutations: 8, seed: 11 });
    const spread = (r: typeof one) => {
      const a = r.answers.q!;
      if (a.type !== 'choice') throw new Error();
      const v = Object.values(a.probabilities);
      return Math.max(...v) - Math.min(...v);
    };
    expect(spread(many)).toBeLessThan(spread(one));
  });

  it('follows scripted rules (probability depends on the state)', async () => {
    const fake = new FakeBackend({ rules: [whenContains('process.env.TTL', 0.9, 0.1, 'auth')] });
    const withSpan = await decide('ttl = process.env.TTL', { auth: questions.auth! }, fake);
    const hidden = await decide('ttl = 3600', { auth: questions.auth! }, fake);
    if (withSpan.answers.auth!.type !== 'yesno' || hidden.answers.auth!.type !== 'yesno') throw new Error();
    expect(withSpan.answers.auth!.p).toBeCloseTo(0.9);
    expect(hidden.answers.auth!.p).toBeCloseTo(0.1);
    expect(withSpan.answers.auth!.p - hidden.answers.auth!.p).toBeCloseTo(0.8);
  });

  it('assigns bands from confidence, with per-question and default overrides', async () => {
    const fake = new FakeBackend({ rules: [() => 0.9] });
    const q: Question = { type: 'yesno', instructions: 'x' };
    const res = await decide('s', { plain: q, strict: { ...q, bands: { act: 0.95 } } }, fake);
    // p=0.9 -> confidence 0.8
    expect(res.answers.plain!.confidence).toBeCloseTo(0.8);
    expect(res.answers.plain!.band).toBe('confirm');
    expect(res.answers.strict!.band).toBe('confirm');
    const loose = await decide('s', { plain: q }, fake, { bands: { act: 0.75 } });
    expect(loose.answers.plain!.band).toBe('act');
    const low = await decide('s', { q }, new FakeBackend({ rules: [() => 0.6] }));
    expect(low.answers.q!.band).toBe('escalate');
  });

  it('applies per-question calibrators and logs raw and calibrated', async () => {
    const fake = new FakeBackend({ rules: [() => 0.8] });
    const res = await decide('s', { q: questions.auth! }, fake, {
      calibrators: { q: { kind: 'temperature', T: 2 } },
    });
    const rec = res.records[0]!;
    expect(rec.raw.true).toBeCloseTo(0.8);
    expect(rec.calibrated.true).toBeCloseTo(2 / 3);
    expect(rec.calibrator).toEqual({ kind: 'temperature', T: 2 });
    if (res.answers.q!.type !== 'yesno') throw new Error();
    expect(res.answers.q!.p).toBeCloseTo(2 / 3);
  });

  it('writes a complete decision record per question', async () => {
    const res = await decide({ code: 'x' }, questions, new FakeBackend({ model: 'm1' }));
    expect(res.records).toHaveLength(3);
    const rec = res.records.find((r) => r.questionId === 'risk')!;
    expect(rec).toMatchObject({
      stateHash: hashState({ code: 'x' }),
      backend: 'fake',
      model: 'm1',
      permutations: 2,
      question: questions.risk,
    });
    expect(Object.keys(rec.raw)).toEqual(['0', '1', '2']);
    expect(rec.calibrator).toBeUndefined();
    expect(new Date(rec.ts).toString()).not.toBe('Invalid Date');
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
    expect(res.stateHash).toBe(rec.stateHash);
  });

  it('survives one failed permutation and averages the rest', async () => {
    const fake = new FakeBackend({ failCalls: [1], rules: [() => 0.7] });
    const res = await decide('s', { q: questions.auth! }, fake);
    expect(res.records[0]!.permutations).toBe(1);
    if (res.answers.q!.type !== 'yesno') throw new Error();
    expect(res.answers.q!.p).toBeCloseTo(0.7);
  });

  it('throws when every call fails', async () => {
    const fake = new FakeBackend({ failCalls: [0, 1] });
    await expect(decide('s', questions, fake)).rejects.toThrow(/no answer for question/);
  });

  it('ignores empty or all-zero distributions', async () => {
    let n = 0;
    const backend: Backend = {
      name: 'flaky',
      capabilities: { hasLogprobs: false, batch: true },
      async answerBatch() {
        n++;
        return n === 1 ? { q: { A: 0, B: 0 } } : { q: { A: 0.2, B: 0.8 } };
      },
    };
    const res = await decide('s', { q: questions.auth! }, backend);
    // second call is the reversed order, so A=false, B=true
    if (res.answers.q!.type !== 'yesno') throw new Error();
    expect(res.answers.q!.p).toBeCloseTo(0.8);
    expect(res.records[0]!.permutations).toBe(1);
    expect(res.records[0]!.model).toBeUndefined();
  });

  it('validates questions before calling the backend', async () => {
    const fake = new FakeBackend();
    await expect(
      decide('s', { bad: { type: 'choice', instructions: 'x', criteria: { only: '' } } }, fake),
    ).rejects.toThrow(QuestionError);
    expect(fake.calls).toHaveLength(0);
  });

  it('returns nothing and calls nothing for zero questions', async () => {
    const fake = new FakeBackend();
    const res = await decide('s', {}, fake);
    expect(res).toMatchObject({ answers: {}, records: [], calls: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it('is deterministic for a given state and seed', async () => {
    const a = await decide('s', questions, new FakeBackend({ seed: 9 }), { permutations: 3, seed: 4 });
    const b = await decide('s', questions, new FakeBackend({ seed: 9 }), { permutations: 3, seed: 4 });
    expect(a.answers).toEqual(b.answers);
  });

  it('passes the abort signal through to the backend', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const backend: Backend = {
      name: 'sig',
      capabilities: { hasLogprobs: false, batch: true },
      async answerBatch(_s, qs, opts) {
        seen.push(opts?.signal);
        return Object.fromEntries(Object.keys(qs).map((id) => [id, { A: 0.5, B: 0.5 }]));
      },
    };
    const ctrl = new AbortController();
    await decide('s', { q: questions.auth! }, backend, { signal: ctrl.signal, permutations: 1 });
    expect(seen).toEqual([ctrl.signal]);
  });
});
