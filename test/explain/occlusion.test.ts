import { describe, expect, it } from 'vitest';
import { FakeBackend, type FakeRule } from '../../src/backends/fake.js';
import { occlude, optionProbability, relevanceQuestions } from '../../src/explain/occlusion.js';
import type { Chunk } from '../../src/scope.js';
import type { Question } from '../../src/types.js';

const chunks: Chunk[] = [
  { id: 'c1', file: 'src/auth/session.ts', startLine: 1, endLine: 3, text: "import { randomBytes } from 'node:crypto';" },
  { id: 'c2', file: 'src/auth/session.ts', startLine: 11, endLine: 12, text: 'const SESSION_TTL_MS = Number(process.env.SESSION_TTL) * 1000;' },
  { id: 'c3', file: 'src/auth/session.ts', startLine: 30, endLine: 34, text: 'export function issueToken(userId) {\n  return save(userId);\n}' },
  { id: 'c4', file: 'src/auth/middleware.ts', startLine: 18, endLine: 18, text: "if (!header) { next(); return true; }" },
];
const question: Question = { type: 'yesno', instructions: 'Does this change auth behavior?' };

/** P(yes) = 0.1 + 0.6 if the env TTL line is visible + 0.25 if the header check is visible. */
const mainRule: FakeRule = (ctx) => {
  if (ctx.questionId !== 'q') return undefined;
  return 0.1 + (ctx.text.includes('process.env.SESSION_TTL') ? 0.6 : 0) + (ctx.text.includes('if (!header)') ? 0.25 : 0);
};

describe('occlude', () => {
  it('highlights exactly the spans whose removal drops p, strongest first', async () => {
    const backend = new FakeBackend({ rules: [mainRule] });
    const res = await occlude(chunks, question, 'true', backend, { topK: 10, relevance: {} });
    expect(res.baselineP).toBeCloseTo(0.95, 6);
    expect(res.highlights.map((h) => `${h.file}:${h.startLine}`)).toEqual(['src/auth/session.ts:11', 'src/auth/middleware.ts:18']);
    expect(res.highlights[0]!.deltaP).toBeCloseTo(-0.6, 3);
    expect(res.highlights[1]!.deltaP).toBeCloseTo(-0.25, 3);
    expect(res.highlights.every((h) => h.kind === 'causal')).toBe(true);
    // The neutral chunks were tested and moved nothing.
    expect(res.trials.filter((t) => t.deltaP === 0).map((t) => t.chunkId).sort()).toEqual(['c1', 'c3']);
  });

  it('measures deltaP against the chosen option (NO answers too)', async () => {
    const backend = new FakeBackend({ rules: [(ctx) => (ctx.text.includes('if (!header)') ? 0.1 : 0.6)] });
    const res = await occlude(chunks, question, 'false', backend, { relevance: {}, baseline: 0.9 });
    const h = res.highlights.find((x) => x.startLine === 18)!;
    // Without the header check P(no) falls from 0.9 to 0.4.
    expect(h.deltaP).toBeCloseTo(-0.5, 3);
  });

  it('asks the relevance prefilter and only re-asks the top-K chunks', async () => {
    const relevant: FakeRule = (ctx) =>
      ctx.questionId.startsWith('rel:') ? (ctx.question.instructions.includes('src/auth/session.ts:11-12') ? 0.9 : 0.1) : undefined;
    const backend = new FakeBackend({ rules: [relevant, mainRule] });
    const res = await occlude(chunks, question, 'true', backend, { topK: 1, baseline: 0.95 });
    expect(res.candidates).toEqual(['c2']);
    expect(res.trials.map((t) => t.chunkId)).toEqual(['c2']);
    // One prefilter batch (2 permutations) plus one re-ask (2 permutations).
    expect(res.calls).toBe(4);
    expect(backend.calls).toHaveLength(4);
  });

  it('never spends more calls than the budget', async () => {
    const backend = new FakeBackend({ rules: [mainRule] });
    const res = await occlude(chunks, question, 'true', backend, { budget: 5, relevance: {} });
    // No baseline given: 2 calls for it, then one re-ask (2 calls) fits in the remaining 3.
    expect(res.calls).toBeLessThanOrEqual(5);
    expect(backend.calls.length).toBe(res.calls);
    expect(res.trials).toHaveLength(1);
    expect(res.untested).toHaveLength(3);
  });

  it('drops highlights under minDelta and caps their number', async () => {
    const backend = new FakeBackend({ rules: [mainRule] });
    const res = await occlude(chunks, question, 'true', backend, { relevance: {}, minDelta: 0.3 });
    expect(res.highlights).toHaveLength(1);
    const capped = await occlude(chunks, question, 'true', backend, { relevance: {}, maxHighlights: 1, minDelta: 0.01 });
    expect(capped.highlights).toHaveLength(1);
  });

  it('skips a chunk whose re-ask fails instead of failing', async () => {
    // Calls 0 and 1 are both permutations of the c1 re-ask, so that re-ask fails.
    const backend = new FakeBackend({ rules: [mainRule], failCalls: [0, 1], batch: true });
    const res = await occlude(chunks, question, 'true', backend, { relevance: {}, baseline: 0.95, concurrency: 1 });
    expect(res.untested).toContain('c1');
    expect(res.highlights[0]!.startLine).toBe(11);
  });
});

describe('helpers', () => {
  it('optionProbability reads each answer type', () => {
    expect(optionProbability({ type: 'yesno', p: 0.8, confidence: 0.6, band: 'confirm' }, 'false')).toBeCloseTo(0.2);
    expect(optionProbability({ type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.4, band: 'escalate' }, 'b')).toBe(0.3);
  });

  it('relevance questions quote each chunk header', () => {
    const qs = relevanceQuestions(chunks, 'Q?');
    expect(Object.keys(qs)).toEqual(['rel:c1', 'rel:c2', 'rel:c3', 'rel:c4']);
    expect(qs['rel:c4']!.instructions).toContain('"src/auth/middleware.ts:18"');
  });
});
