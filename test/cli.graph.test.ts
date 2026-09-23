import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRule } from '../src/backends/fake.js';
import { main, type CliIo } from '../src/cli/index.js';
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
];

let root: string;

function io(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: async () => '',
    env: { GLASSBOX_BACKEND: 'fake' },
    cwd: root,
    backendConfig: { fake: { rules } },
    ...extra,
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const t = io(extra);
  const code = await main(args, t.io);
  return { code, out: t.out(), err: t.err() };
}

const DIFF = [
  '--- a/src/auth/session.ts',
  '+++ b/src/auth/session.ts',
  '@@ -41,1 +41,1 @@',
  '-  if (session.expiresAt < Date.now()) {',
  '+  if (session.expiresAt <= Date.now()) {',
  '',
].join('\n');

describe('cli: graph commands on a copy of the sample repo', () => {
  beforeAll(async () => {
    root = await fixtureCopy();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('init indexes, tags and writes AGENTS.md plus the CLAUDE.md import', async () => {
    const r = await run(['init', '--group-size', '8']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^graph {2}17 files, \d+ nodes/);
    expect(r.out).toMatch(/\ntags {3}\d+ nodes asked, 0 cached, \d+ calls/);
    expect(r.out).toContain('sync   AGENTS.md created, CLAUDE.md created');
    expect(r.err).toMatch(/tags {2}\d+\/\d+ nodes/);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('### Risky nodes');
    expect(existsSync(join(root, '.glassbox', 'graph.db'))).toBe(true);
  });

  it('index again serves every tag from the cache', async () => {
    const r = await run(['index', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as { tags: { asked: number; cached: number; calls: number } };
    expect(json.tags.asked).toBe(0);
    expect(json.tags.calls).toBe(0);
    expect(json.tags.cached).toBeGreaterThan(40);
  });

  it('where ranks the retry code first', async () => {
    const r = await run(['where', 'billing', 'charge', 'retries']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[1]).toMatch(/^ {2}p=0\.90 +src\/billing\/retry\.ts:7-18 +retryCharge \(function\)$/);
  });

  it('triage reads a diff from stdin and logs an explainable decision', async () => {
    const r = await run(['triage', '--diff', '-', '--json'], { readStdin: async () => DIFF });
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as { level: string; id: string; affected: { name: string }[]; hunks: { nodes: string[] }[] };
    expect(json.level).toBe('High');
    expect(json.hunks[0]!.nodes).toEqual(['src/auth/session.ts#verifySession']);
    expect(json.affected.map((a) => a.name)).toEqual(['requireAuth']);

    const e = await run(['explain', json.id]);
    expect(e.code).toBe(0);
    expect(e.out).toMatch(/^[0-9a-f]{12} {2}triage /);
    expect(e.out).toContain('highlights\n  src/auth/session.ts:41');
    expect(e.out).toContain('cost  0 calls (from the log)');
  });

  it('decide advises between options and says it is advice only', async () => {
    const r = await run(['decide', 'Keep', 'the', 'TTL', 'in', 'session.ts?', '--options', 'keep,move', '--context', 'env has no fallback']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^move {2}p=0\.75 /);
    expect(r.out).toContain('advice only');
    expect(r.out).toMatch(/context {2}.*src\/auth\/session\.ts#/);
    expect((await run(['decide', 'no options?'])).code).toBe(2);
  });

  it('graph shows tags and neighbours, by id or unique name', async () => {
    const r = await run(['graph', 'verifySession']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^`src\/auth\/session\.ts#verifySession` {2}\(function, src\/auth\/session\.ts:38-46\)/);
    expect(r.out).toContain('  handles_auth=yes 0.90');
    expect(r.out).toMatch(/\nin\n( {2}.*\n)* {2}calls {4}`src\/auth\/middleware\.ts#requireAuth`/);
    // A method resolves by its bare name when that is unique.
    expect((await run(['graph', 'get'])).out).toMatch(/^`src\/auth\/session\.ts#SessionStore\.get` /);
    const none = await run(['graph', 'noSuchThing']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('no node "noSuchThing"');
  });

  it('sync-md is idempotent and index picks up edits incrementally', async () => {
    expect((await run(['sync-md'])).out).toContain('AGENTS.md unchanged, CLAUDE.md unchanged');
    const file = join(root, 'src/ui/format.ts');
    await writeFile(file, `${await readFile(file, 'utf8')}\nexport const pad = (n: number): string => String(n).padStart(2, '0');\n`);
    const r = await run(['index', '--quiet']);
    expect(r.out).toMatch(/\(\+1 ~\d+ -0/);
    const asked = Number(/tags {3}(\d+) nodes asked/.exec(r.out)![1]);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(10);
    expect(r.err).toBe('');
  });

  it('where on a repo with no index builds the graph first', async () => {
    const fresh = await fixtureCopy();
    try {
      const r = await run(['where', 'retry', '--root', fresh]);
      expect(r.code).toBe(0);
      expect(r.err).toContain('no index yet');
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
