import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRule } from '../../src/backends/fake.js';
import { createGlassboxServer } from '../../src/mcp/server.js';
import { indexedFixture, rules } from './helpers.js';

const unsure: FakeRule = (ctx) => (ctx.questionId === 'q' && ctx.question.type === 'yesno' ? 0.7 : undefined);
const whereRule: FakeRule = (ctx) => (ctx.questionId.startsWith('where:') ? (ctx.question.instructions.includes('retry.ts:7-18') ? 0.99 : 0.01) : undefined);

let root: string;

async function connect(env: NodeJS.ProcessEnv = {}) {
  const server = createGlassboxServer({ root, env: { GLASSBOX_BACKEND: 'fake', ...env }, backendConfig: { fake: { rules: [...rules, unsure, whereRule] } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown>) {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: r.isError === true };
    },
    close: () => Promise.all([client.close(), server.close()]),
  };
}

beforeAll(async () => {
  root = await indexedFixture();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('mcp mode parameter', () => {
  it('is offered on ask, where, triage and decide', async () => {
    const c = await connect();
    try {
      const { tools } = await c.client.listTools();
      for (const name of ['ask', 'where', 'triage', 'decide']) {
        const props = (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
        expect(props.mode?.enum).toEqual(['fast', 'balanced', 'explained', 'strict', 'auto']);
      }
    } finally {
      await c.close();
    }
  });

  it('fast asks once; auto escalates an unsure answer and reports it', async () => {
    const c = await connect();
    try {
      const fast = JSON.parse((await c.call('ask', { question: 'is this about sessions?', paths: ['src/auth/session.ts'], mode: 'fast', format: 'json' })).text) as {
        calls: { decide: number };
        mode: { used: string };
      };
      expect(fast.calls.decide).toBe(1);
      expect(fast.mode.used).toBe('fast');
      const auto = await c.call('ask', { question: 'is this about sessions?', paths: ['src/auth/session.ts'], mode: 'auto' });
      expect(auto.text).toContain('mode   auto: fast gave band escalate, asked again in explained');
    } finally {
      await c.close();
    }
  });

  it('falls back to GLASSBOX_MODE and to .glassbox/config.json', async () => {
    await writeFile(join(root, '.glassbox', 'config.json'), JSON.stringify({ mode: 'fast' }));
    try {
      const c = await connect();
      try {
        const r = JSON.parse((await c.call('where', { concept: 'billing retries', format: 'json' })).text) as { mode: { requested: string; source: string } };
        expect(r.mode).toMatchObject({ requested: 'fast', source: 'project' });
      } finally {
        await c.close();
      }
      const e = await connect({ GLASSBOX_MODE: 'strict' });
      try {
        const out = await e.call('decide', { question: 'keep or move?', options: ['keep', 'move'], format: 'json' });
        const r = JSON.parse(out.text) as { mode: { requested: string; source: string } };
        expect(r.mode).toMatchObject({ requested: 'strict', source: 'env' });
      } finally {
        await e.close();
      }
    } finally {
      await rm(join(root, '.glassbox', 'config.json'));
    }
  });

  it('fast triage skips the evidence pass', async () => {
    const c = await connect();
    try {
      const diff = ['--- a/src/auth/session.ts', '+++ b/src/auth/session.ts', '@@ -41,1 +41,1 @@', '-  if (session.expiresAt < Date.now()) {', '+  if (session.expiresAt <= Date.now()) {', ''].join('\n');
      const r = JSON.parse((await c.call('triage', { diff, mode: 'fast', format: 'json' })).text) as { calls: { decide: number; explain: number } };
      expect(r.calls).toEqual({ decide: 1, explain: 0 });
    } finally {
      await c.close();
    }
  });

  it('rejects an unknown mode', async () => {
    const c = await connect();
    try {
      const r = await c.call('ask', { question: 'x?', mode: 'warp' });
      expect(r.isError).toBe(true);
    } finally {
      await c.close();
    }
  });
});
