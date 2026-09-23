import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliIo } from '../src/cli/index.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'sample-repo');

function io(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: async () => '',
    env: { GLASSBOX_BACKEND: 'fake' },
    cwd: FIXTURE,
    ...extra,
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

describe('cli', () => {
  it('prints help and version', async () => {
    const h = io();
    expect(await main([], h.io)).toBe(0);
    expect(h.out()).toContain('ask');
    const v = io();
    expect(await main(['--version'], v.io)).toBe(0);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('ask --json over a path', async () => {
    const t = io({ backendConfig: { fake: { rules: [() => 0.9] } } });
    const code = await main(['ask', 'Does', 'this', 'query', 'the', 'db?', '--path', 'src/db.ts', '--no-log', '--json'], t.io);
    expect(t.err()).toBe('');
    expect(code).toBe(0);
    const json = JSON.parse(t.out()) as { label: string; answer: { p: number }; question: { instructions: string }; calls: { decide: number } };
    expect(json.label).toBe('YES');
    expect(json.answer.p).toBeCloseTo(0.9, 6);
    expect(json.question.instructions).toBe('Does this query the db?');
    expect(json.calls.decide).toBe(2);
  });

  it('ask --explain prints highlights in the readable format', async () => {
    const rule = (ctx: { questionId: string; text: string }) =>
      ctx.questionId === 'q' ? (ctx.text.includes('process.env.SESSION_TTL') ? 0.9 : 0.2) : undefined;
    const t = io({ backendConfig: { fake: { rules: [rule] } } });
    const code = await main(
      ['ask', 'Is the TTL read from env?', '--path', 'src/auth/session.ts', '--explain', '--top-k', '40', '--budget', '100', '--no-why', '--no-log'],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.out()).toMatch(/^YES {2}p=0\.90/);
    expect(t.out()).toMatch(/highlights\n {2}src\/auth\/session\.ts:11-12 +Δp -0\.70/);
  });

  it('ask a choice question over a diff from stdin', async () => {
    const diff = '--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n';
    const t = io({ readStdin: async () => diff, backendConfig: { fake: { rules: [() => ({ refactor: 1, fix: 3 })] } } });
    const code = await main(['ask', 'What kind of change?', '--type', 'choice', '--options', 'fix,refactor', '--diff', '-', '--no-log', '--json', '--no-why'], t.io);
    expect(code).toBe(0);
    const json = JSON.parse(t.out()) as { label: string; scope: string[] };
    expect(json.label).toBe('fix');
    expect(json.scope).toEqual(['src/db.ts:1']);
  });

  it('reports usage and runtime errors with exit codes', async () => {
    const bad = io();
    expect(await main(['ask', 'q?', '--type', 'nope'], bad.io)).toBe(2);
    expect(bad.err()).toContain('nope');
    const missing = io();
    expect(await main(['ask', 'q?', '--path', 'no/such/file.ts', '--no-log'], missing.io)).toBe(1);
    expect(missing.err()).toContain('no such file');
    const backend = io();
    expect(await main(['ask', 'q?', '--backend', 'no-such-backend', '--no-log'], backend.io)).toBe(2);
  });
});
