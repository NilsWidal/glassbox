import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRule } from '../src/backends/fake.js';
import { main } from '../src/cli/index.js';
import { withPluginOptions, defaultRoot } from '../src/mcp/env.js';
import { createGlassboxServer } from '../src/mcp/server.js';
import { fixtureCopy, tagRule } from './query/helpers.js';

const rules: FakeRule[] = [
  tagRule,
  (ctx) => (ctx.questionId.startsWith('where:') ? (ctx.question.instructions.includes('retry.ts:7-18') ? 0.9 : 0.1) : undefined),
  (ctx) =>
    ctx.question.instructions.startsWith('How risky is this change overall')
      ? ctx.text.includes('expiresAt')
        ? { '2': 0.8, '1': 0.1, '0': 0.1 }
        : { '0': 0.9, '1': 0.05, '2': 0.05 }
      : undefined,
  (ctx) => (ctx.questionId === 'q' && ctx.question.type === 'choice' ? { keep: 1, move: 3 } : undefined),
  (ctx) => (ctx.questionId === 'q' && ctx.question.instructions.includes('session') ? 0.9 : undefined),
];

const DIFF = [
  '--- a/src/auth/session.ts',
  '+++ b/src/auth/session.ts',
  '@@ -41,1 +41,1 @@',
  '-  if (session.expiresAt < Date.now()) {',
  '+  if (session.expiresAt <= Date.now()) {',
  '',
].join('\n');

let root: string;
let client: Client;

function textOf(r: unknown): string {
  const res = r as CallToolResult;
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { text: textOf(r), isError: r.isError === true };
}

describe('mcp server over an in-memory transport', () => {
  beforeAll(async () => {
    root = await fixtureCopy();
    // Build the graph and tags with the CLI, as a user would with `glassbox init`.
    const code = await main(['init', '--quiet', '--group-size', '8'], {
      stdout: () => {},
      stderr: () => {},
      readStdin: async () => '',
      env: { GLASSBOX_BACKEND: 'fake' },
      cwd: root,
      backendConfig: { fake: { rules } },
    });
    expect(code).toBe(0);
    const server = createGlassboxServer({
      env: { GLASSBOX_BACKEND: 'fake' },
      cwd: root,
      backendConfig: { fake: { rules } },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('lists the seven tools with input schemas and sends instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask', 'decide', 'explain', 'graph', 'refresh', 'triage', 'where']);
    const ask = tools.find((t) => t.name === 'ask')!;
    expect(ask.inputSchema.required).toEqual(['question']);
    expect(Object.keys(ask.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['type', 'options', 'paths', 'diff', 'explain']));
    expect(tools.find((t) => t.name === 'decide')!.inputSchema.required).toEqual(['question', 'options']);
    expect(client.getInstructions()).toContain('Band act');
  });

  it('ask answers a typed question over paths', async () => {
    const r = await call('ask', { question: 'does this handle session expiry?', paths: ['src/auth/session.ts'] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^YES {2}p=0\.90/);
    expect(r.text).toMatch(/\nid {4}[0-9a-f]{12}/);
  });

  it('ask returns JSON on request', async () => {
    const r = await call('ask', { question: 'does this handle session expiry?', paths: ['src/auth/session.ts'], format: 'json' });
    const json = JSON.parse(r.text) as { answer: { type: string; p: number; band: string } };
    expect(json.answer.type).toBe('yesno');
    expect(json.answer.p).toBeCloseTo(0.9, 2);
  });

  it('where ranks the retry code first', async () => {
    const r = await call('where', { concept: 'billing charge retries' });
    expect(r.text.split('\n')[1]).toMatch(/p=0\.90 +src\/billing\/retry\.ts:7-18 +retryCharge/);
  });

  it('triage rates a diff and explain reads the logged evidence', async () => {
    const r = await call('triage', { diff: DIFF, format: 'json' });
    const json = JSON.parse(r.text) as { level: string; id: string; affected: { name: string }[] };
    expect(json.level).toBe('High');
    expect(json.affected.map((a) => a.name)).toEqual(['requireAuth']);
    const e = await call('explain', { id: json.id });
    expect(e.isError).toBe(false);
    expect(e.text).toContain('highlights\n  src/auth/session.ts:41');
    expect(e.text).toContain('cost  0 calls (from the log)');
  });

  it('decide advises between options', async () => {
    const r = await call('decide', { question: 'Keep the TTL in session.ts?', options: ['keep', 'move'] });
    expect(r.text).toMatch(/^move {2}p=0\.75 /);
    expect(r.text).toContain('advice only');
  });

  it('graph shows a node with tags and neighbours, and errors on unknown nodes', async () => {
    const r = await call('graph', { node: 'verifySession' });
    expect(r.text).toContain('handles_auth=yes 0.90');
    const none = await call('graph', { node: 'noSuchThing' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('no node "noSuchThing"');
  });

  it('refresh marks edited files stale and re-parses the repo', async () => {
    const r = await call('refresh', { files: [join(root, 'src/auth/session.ts'), 'src/new-file.ts'], format: 'json' });
    const json = JSON.parse(r.text) as { indexed: boolean; stale: string[]; unknownFiles: string[] };
    expect(json.indexed).toBe(true);
    expect(json.stale).toContain('src/auth/session.ts#verifySession');
    // One hop: the caller of verifySession is stale too.
    expect(json.stale).toContain('src/auth/middleware.ts#requireAuth');
    expect(json.unknownFiles).toEqual(['src/new-file.ts']);
    const full = await call('refresh', { syncMd: true });
    expect(full.text).toMatch(/^graph {2}\+0 ~0 -0/);
    expect(full.text).toContain('sync   AGENTS.md');
  });

  it('reports bad input and tool failures as errors, not crashes', async () => {
    const bad = await call('decide', { question: 'x?', options: ['only-one'] });
    expect(bad.isError).toBe(true);
    const missing = await call('explain', { id: 'ffffffff' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('no decision with id');
  });
});

describe('mcp server in a repo without a graph', () => {
  it('refresh does nothing and creates no .glassbox/', async () => {
    const fresh = await fixtureCopy();
    try {
      const server = createGlassboxServer({ env: { GLASSBOX_BACKEND: 'fake' }, cwd: fresh });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: 'test', version: '0.0.0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      const r = textOf(await c.callTool({ name: 'refresh', arguments: { files: ['src/auth/session.ts'] } }));
      expect(r).toContain('no glassbox graph here yet');
      expect(existsSync(join(fresh, '.glassbox'))).toBe(false);
      await c.close();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe('plugin userConfig env mapping', () => {
  it('maps CLAUDE_PLUGIN_OPTION_* onto glassbox variables without overriding the user', () => {
    const env = withPluginOptions({
      CLAUDE_PLUGIN_OPTION_BACKEND: 'anthropic',
      CLAUDE_PLUGIN_OPTION_MODEL: '',
      CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_PLUGIN_OPTION_OPENAI_BASE_URL: 'http://example.test/v1',
      GLASSBOX_OPENAI_BASE_URL: 'http://mine.test/v1',
    });
    expect(env.GLASSBOX_BACKEND).toBe('anthropic');
    expect(env.GLASSBOX_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.GLASSBOX_OPENAI_BASE_URL).toBe('http://mine.test/v1');
  });

  it('resolves auto to the launching host from GLASSBOX_HOST, but never overrides an explicit backend', () => {
    expect(withPluginOptions({ GLASSBOX_HOST: 'claude-code' }).GLASSBOX_BACKEND).toBe('claude-cli');
    expect(withPluginOptions({ GLASSBOX_HOST: 'codex', GLASSBOX_BACKEND: 'auto' }).GLASSBOX_BACKEND).toBe('codex-cli');
    expect(withPluginOptions({ GLASSBOX_HOST: 'claude-code', CLAUDE_PLUGIN_OPTION_BACKEND: 'auto' }).GLASSBOX_BACKEND).toBe('claude-cli');
    expect(withPluginOptions({ GLASSBOX_HOST: 'claude-code', CLAUDE_PLUGIN_OPTION_BACKEND: 'anthropic' }).GLASSBOX_BACKEND).toBe('anthropic');
    expect(withPluginOptions({ GLASSBOX_HOST: 'other' }).GLASSBOX_BACKEND).toBeUndefined();
  });

  it('picks the root from GLASSBOX_ROOT, then CLAUDE_PROJECT_DIR, then cwd', () => {
    expect(defaultRoot({ GLASSBOX_ROOT: '/a', CLAUDE_PROJECT_DIR: '/b' }, '/c')).toBe('/a');
    expect(defaultRoot({ CLAUDE_PROJECT_DIR: '/b' }, '/c')).toBe('/b');
    expect(defaultRoot({}, '/c')).toBe('/c');
    // An unexpanded placeholder from a host that does not substitute it is ignored.
    expect(defaultRoot({ GLASSBOX_ROOT: '${CLAUDE_PROJECT_DIR}' }, '/c')).toBe('/c');
  });
});

describe('cli refresh', () => {
  it('is quiet and exits 0 without a graph (the hook path)', async () => {
    const fresh = await fixtureCopy();
    try {
      const out: string[] = [];
      const code = await main(['refresh', '--files', 'src/auth/session.ts', '--quiet'], {
        stdout: (t) => out.push(t),
        stderr: (t) => out.push(t),
        readStdin: async () => '',
        env: {},
        cwd: fresh,
      });
      expect(code).toBe(0);
      expect(out.join('')).toBe('');
      expect(existsSync(join(fresh, '.glassbox'))).toBe(false);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
