import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backends/fake.js';
import { buildWhyPrompt, clampWords, explainWhy, parseWhy, shouldExplainWhy } from '../../src/explain/why.js';
import type { Chunk } from '../../src/scope.js';
import type { Backend, Highlight, YesNoAnswer } from '../../src/types.js';

const answer: YesNoAnswer = { type: 'yesno', p: 0.7, confidence: 0.4, band: 'escalate' };
const chunks: Chunk[] = [{ id: 'c1', file: 'a.ts', startLine: 3, endLine: 4, text: 'const ttl = process.env.TTL;' }];
const highlights: Highlight[] = [{ file: 'a.ts', startLine: 3, endLine: 4, deltaP: -0.4, kind: 'causal' }];
const question = { type: 'yesno' as const, instructions: 'Is config read from env?' };

describe('why', () => {
  it('runs on request or when the band is not act', () => {
    expect(shouldExplainWhy(answer, undefined)).toBe(true);
    expect(shouldExplainWhy({ ...answer, band: 'act' }, undefined)).toBe(false);
    expect(shouldExplainWhy({ ...answer, band: 'act' }, true)).toBe(true);
    expect(shouldExplainWhy(answer, false)).toBe(false);
  });

  it('clamps to 12 words and removes dash characters', () => {
    const em = String.fromCharCode(0x2014);
    expect(clampWords(`"reads TTL ${em} no fallback"`)).toBe('reads TTL, no fallback');
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(clampWords(long).split(' ')).toHaveLength(12);
  });

  it('parses WHY and per-highlight lines', () => {
    const r = parseWhy('WHY: TTL now comes from env\n**H1**: reads process.env with no fallback\nH9: ignored', 1);
    expect(r.why).toEqual({ text: 'TTL now comes from env', kind: 'narrative' });
    expect(r.comments).toEqual(['reads process.env with no fallback']);
  });

  it('includes highlighted code in the prompt', () => {
    const p = buildWhyPrompt({ question, answer, chunks, highlights });
    expect(p).toContain('[H1] a.ts:3-4');
    expect(p).toContain('process.env.TTL');
    expect(p).toContain('WHY:');
  });

  it('uses one generate call and fails soft', async () => {
    const fake = new FakeBackend({ generate: () => 'WHY: reads env\nH1: env read' });
    const r = await explainWhy(fake, { question, answer, chunks, highlights });
    expect(r?.comments).toEqual(['env read']);
    expect(fake.generated).toHaveLength(1);

    const broken: Backend = { ...fake, name: 'x', capabilities: { hasLogprobs: false, batch: true, generate: true }, answerBatch: fake.answerBatch.bind(fake), generate: () => Promise.reject(new Error('down')) };
    expect(await explainWhy(broken, { question, answer, chunks })).toBeUndefined();
    const none: Backend = { name: 'y', capabilities: { hasLogprobs: false, batch: true }, answerBatch: fake.answerBatch.bind(fake) };
    expect(await explainWhy(none, { question, answer, chunks })).toBeUndefined();
  });
});
