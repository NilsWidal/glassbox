import { describe, expect, it } from 'vitest';
import { batchForPermutation } from '../../src/engine/decide.js';
import { HttpError, OpenAICompatBackend } from '../../src/backends/openai-compat.js';
import type { Question } from '../../src/types.js';
import { batch } from './helpers.js';

type Body = { messages: Array<{ content: string }>; top_logprobs: number; max_tokens: number; logprobs: boolean };

function logprobResponse(tops: Record<string, number>) {
  const top_logprobs = Object.entries(tops).map(([token, p]) => ({ token, logprob: Math.log(p) }));
  return { choices: [{ message: { content: top_logprobs[0]?.token ?? '' }, logprobs: { content: [{ ...top_logprobs[0]!, top_logprobs }] } }] };
}

function fakeFetch(respond: (body: Body, n: number) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const bodies: Body[] = [];
  const f = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as Body;
    bodies.push(body);
    const r = respond(body, bodies.length - 1);
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.json ?? {}), { status, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

const opts = { model: 'm', env: {}, sleep: async () => {} };

describe('OpenAICompatBackend', () => {
  it('asks one question per call and reads label logprobs', async () => {
    const { f, bodies } = fakeFetch((b) =>
      b.messages[0]!.content.includes('side effects') ? { json: logprobResponse({ A: 0.7, ' B': 0.2, x: 0.1 }) } : { json: logprobResponse({ C: 0.5, A: 0.25, B: 0.25 }) },
    );
    const out = await new OpenAICompatBackend({ ...opts, fetch: f }).answerBatch('code', batch);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.top_logprobs).toBe(20);
    expect(bodies[0]!.max_tokens).toBe(1);
    expect(bodies[0]!.logprobs).toBe(true);
    expect(out.sideEffects!.A).toBeCloseTo(0.7);
    expect(out.sideEffects!.B).toBeCloseTo(0.2);
    expect(out.kind!.C).toBeCloseTo(0.5);
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    const slept: number[] = [];
    const { f, bodies } = fakeFetch((_b, n) =>
      n === 0 ? { status: 429, headers: { 'retry-after': '2' } } : n === 1 ? { status: 503 } : { json: logprobResponse({ A: 1 }) },
    );
    const one = { sideEffects: batch.sideEffects! };
    const out = await new OpenAICompatBackend({ ...opts, fetch: f, sleep: async (ms) => void slept.push(ms) }).answerBatch('s', one);
    expect(bodies).toHaveLength(3);
    expect(slept[0]).toBe(2000);
    expect(out.sideEffects!.A).toBeCloseTo(1);
  });

  it('does not retry a 400', async () => {
    const { f, bodies } = fakeFetch(() => ({ status: 400, json: { error: 'bad' } }));
    await expect(new OpenAICompatBackend({ ...opts, fetch: f }).answerBatch('s', { sideEffects: batch.sideEffects! })).rejects.toBeInstanceOf(HttpError);
    expect(bodies).toHaveLength(1);
  });

  it('runs a grouped tournament for more than 20 options', async () => {
    const criteria = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`opt${i}`, `option ${i}`]));
    const q: Question = { type: 'choice', instructions: 'Which?', criteria };
    const big = batchForPermutation({ big: q }, 0, 0);
    // Group 1 (opt0..opt19): opt3 wins. Group 2 (opt20..opt24): opt22 wins. Final: group 2 at 0.8.
    const { f, bodies } = fakeFetch((b) => {
      const text = b.messages[0]!.content;
      if (text.includes('option 0') && text.includes('option 19')) return { json: logprobResponse({ D: 0.6, A: 0.4 }) };
      if (text.includes('option 20')) return { json: logprobResponse({ C: 0.6, A: 0.4 }) };
      return { json: logprobResponse({ B: 0.8, A: 0.2 }) };
    });
    const out = await new OpenAICompatBackend({ ...opts, fetch: f }).answerBatch('s', big);
    expect(bodies).toHaveLength(3);
    const final = bodies.find((b) => !b.messages[0]!.content.includes('option 19') && !b.messages[0]!.content.includes('option 20'))!;
    expect(final.messages[0]!.content).toContain('A) opt3: option 3');
    expect(final.messages[0]!.content).toContain('B) opt22: option 22');
    const byKey = (k: string) => out.big![big.big!.labels[big.big!.options.indexOf(k)]!]!;
    expect(byKey('opt3')).toBeCloseTo(0.6 * 0.2);
    expect(byKey('opt0')).toBeCloseTo(0.4 * 0.2);
    expect(byKey('opt22')).toBeCloseTo(0.6 * 0.8);
    expect(byKey('opt20')).toBeCloseTo(0.4 * 0.8);
    expect(Object.values(out.big!).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});
