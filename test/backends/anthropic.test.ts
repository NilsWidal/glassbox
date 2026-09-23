import { describe, expect, it } from 'vitest';
import { AnthropicBackend, splitForCache, type AnthropicClientLike } from '../../src/backends/anthropic.js';
import { answer, batch } from './helpers.js';

function fakeClient(replies: Array<{ text: string; stop_reason?: string }>) {
  const bodies: Array<Record<string, unknown>> = [];
  const client: AnthropicClientLike = {
    messages: {
      async create(body) {
        const r = replies[bodies.length % replies.length]!;
        bodies.push(body);
        return { content: [{ type: 'text', text: r.text }], stop_reason: r.stop_reason ?? 'end_turn' };
      },
    },
  };
  return { client, bodies };
}

describe('AnthropicBackend', () => {
  it('sends structured output, a cached state prefix and no prefill', async () => {
    const { client, bodies } = fakeClient([{ text: JSON.stringify(answer(0.6, [0, 1, 0])) }]);
    const b = new AnthropicBackend({ client, samples: 1, env: {} });
    const out = await b.answerBatch('let secret = process.env.KEY', batch);

    expect(out.sideEffects!.A).toBeCloseTo(0.6);
    const body = bodies[0]!;
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
    const messages = body.messages as Array<{ role: string; content: Array<{ text: string; cache_control?: unknown }> }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    const [prefix, rest] = messages[0]!.content;
    expect(prefix!.cache_control).toEqual({ type: 'ephemeral' });
    expect(prefix!.text).toContain('process.env.KEY');
    expect(prefix!.text.trimEnd().endsWith('</state>')).toBe(true);
    expect(rest!.text).toContain('[q1]');
  });

  it('averages K samples', async () => {
    const { client, bodies } = fakeClient([{ text: JSON.stringify(answer(0.2, [1, 0, 0])) }, { text: JSON.stringify(answer(0.6, [1, 0, 0])) }]);
    const out = await new AnthropicBackend({ client, samples: 2, env: {} }).answerBatch('s', batch);
    expect(bodies).toHaveLength(2);
    expect(out.sideEffects!.A).toBeCloseTo(0.4);
  });

  it('treats refusals as failed samples', async () => {
    const { client } = fakeClient([{ text: '', stop_reason: 'refusal' }]);
    await expect(new AnthropicBackend({ client, samples: 1, env: {} }).answerBatch('s', batch)).rejects.toThrow(/refused/);
  });

  it('splitForCache cuts right after the state', () => {
    expect(splitForCache('head\n<state>\nX\n</state>\n\nQ')).toEqual(['head\n<state>\nX\n</state>\n', '\nQ']);
    expect(splitForCache('no state')).toEqual(['no state', '']);
  });
});
