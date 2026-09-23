import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBackend, whenContains } from '../../src/backends/fake.js';
import { benchFakeRules, itemQuestion, loadBench, renderBenchMarkdown, runBench, validateItem, type BenchSet } from '../../src/calibrate/bench.js';

const benchPromise = loadBench();

describe('bench dataset', () => {
  it('has at least 60 valid items across all three question types', async () => {
    const bench = await benchPromise;
    expect(bench.items.length).toBeGreaterThanOrEqual(60);
    const types = new Set(bench.items.map((i) => i.type));
    expect([...types].sort()).toEqual(['choice', 'score', 'yesno']);
    const yesno = bench.items.filter((i) => i.type === 'yesno');
    // Both answers are well represented, so always saying yes cannot score well.
    expect(yesno.filter((i) => i.truth === 'false').length).toBeGreaterThanOrEqual(15);
    expect(yesno.filter((i) => i.truth === 'true').length).toBeGreaterThanOrEqual(15);
  });

  it('every label is backed by an evidence line that exists in the item files', async () => {
    const bench = await benchPromise;
    for (const item of bench.items) {
      expect(item.evidence, item.id).toBeTruthy();
      const text = (await Promise.all(item.paths.map((p) => readFile(join(bench.repos[item.repo]!, p), 'utf8')))).join('\n');
      expect(text.includes(item.evidence!), `${item.id}: evidence not found`).toBe(true);
    }
  });

  it('rejects malformed items', () => {
    const repos = { r: '/tmp' };
    const base = { id: 'x', repo: 'r', paths: ['a.ts'], question: 'q?' };
    expect(() => validateItem({ ...base, type: 'yesno', truth: 'maybe' }, repos)).toThrow(/not an option/);
    expect(() => validateItem({ ...base, repo: 'nope', type: 'yesno', truth: 'true' }, repos)).toThrow(/unknown repo/);
    expect(() => validateItem({ ...base, type: 'score', levels: ['a'], truth: '0' }, repos)).toThrow(/levels/);
    expect(itemQuestion({ ...base, type: 'score', levels: ['a', 'b'], truth: '1' })).toEqual({ type: 'score', instructions: 'q?', criteria: ['a', 'b'] });
  });
});

describe('bench runner (fake backend)', () => {
  it('batches questions per scope and reports metrics, latency and calls', async () => {
    const bench = await benchPromise;
    const backend = new FakeBackend({ rules: benchFakeRules(bench.items) });
    const r = await runBench(bench, { backend, limit: 20, faithfulness: false });
    expect(r.items).toBe(20);
    expect(r.answered).toBe(20);
    expect(r.harnessOnly).toBe(true);
    expect(r.metrics.n).toBe(20);
    expect(r.metrics.accuracy).toBeGreaterThan(0.5);
    expect(Number.isFinite(r.metrics.ece)).toBe(true);
    // One call per option order per scope group, far fewer than one per question.
    expect(r.calls.decide).toBe(backend.calls.length);
    expect(r.calls.decide).toBeLessThan(20 * 2);
    expect(r.latencyMs.decisions).toBe(r.calls.decide / 2);
    expect(r.crossValidated?.metrics.n).toBe(20);
    const md = renderBenchMarkdown(r);
    expect(md).toContain('Harness-only');
    expect(md).toContain('author-constructed');
    expect(md).not.toContain(String.fromCharCode(0x2014));
  });

  it('marks items failed when the backend errors, without faking answers', async () => {
    const bench = await benchPromise;
    const backend = new FakeBackend({ rules: [() => { throw new Error('boom'); }] });
    const r = await runBench(bench, { backend, limit: 4, faithfulness: false });
    expect(r.answered).toBe(0);
    expect(r.failed).toBe(4);
    expect(r.results.every((x) => x.error?.includes('boom'))).toBe(true);
  });

  it('faithfulness: deleting the evidence drops p, keeping only it holds p, random deletion does not', async () => {
    const item = {
      id: 'env',
      repo: 'sample',
      paths: ['src/auth/session.ts'],
      type: 'yesno' as const,
      question: 'Does this read an environment variable?',
      truth: 'true',
      evidence: 'process.env.SESSION_TTL',
    };
    const bench: BenchSet = { file: 'x', repos: { sample: join(import.meta.dirname, '..', 'fixtures', 'sample-repo') }, items: [item] };
    const backend = new FakeBackend({
      rules: [
        (ctx) => (ctx.question.instructions.startsWith('Is the code under') ? (ctx.question.instructions.includes(':12') ? 0.9 : 0.1) : undefined),
        whenContains('process.env.SESSION_TTL', 0.92, 0.1),
      ],
    });
    const r = await runBench(bench, { backend, faithfulness: { budget: 12, topK: 4 } });
    const f = r.faithfulness!;
    expect(f.tested).toBe(1);
    expect(f.withHighlights).toBe(1);
    expect(f.items[0]!.highlights).toEqual(['src/auth/session.ts:11-12']);
    expect(f.deletionRate).toBe(1);
    expect(f.sufficiencyRate).toBe(1);
    expect(f.controlDropRate).toBe(0);
    expect(f.meanDeletionDrop).toBeCloseTo(0.82, 2);
    expect(r.calls.faithfulness).toBe(f.calls);
  });
});
