import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDecisionLog, ask, makeQuestion } from '../src/ask.js';
import { FakeBackend, type FakeRule } from '../src/backends/fake.js';
import { parseReasons } from '../src/explain/reasons.js';
import { renderJson, renderPretty } from '../src/render.js';
import type { DecisionRecord } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'sample-repo');
const EXPIRY = 'session.expiresAt < Date.now()';

/** The main question hinges on the expiry check inside verifySession. */
const expiryRule: FakeRule = (ctx) => (ctx.questionId === 'q' ? (ctx.text.includes(EXPIRY) ? 0.95 : 0.3) : undefined);

async function tmpLog(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'glassbox-ask-')), 'decisions.jsonl');
}

describe('makeQuestion', () => {
  it('builds each question type from CLI-style input', () => {
    expect(makeQuestion(' q? ')).toEqual({ type: 'yesno', instructions: 'q?' });
    expect(makeQuestion('kind?', 'choice', ['bug=a defect', 'feature'])).toEqual({
      type: 'choice',
      instructions: 'kind?',
      criteria: { bug: 'a defect', feature: '' },
    });
    expect(makeQuestion('risk?', 'score', [])).toMatchObject({ criteria: ['none', 'low', 'medium', 'high'] });
  });
});

describe('ask', () => {
  it('answers over files with one batched call per permutation and logs the record', async () => {
    const backend = new FakeBackend({ rules: [expiryRule] });
    const log = await tmpLog();
    const r = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', { backend, root: FIXTURE, log, why: false });
    expect(r.answer).toMatchObject({ type: 'yesno' });
    expect(r.answer.type === 'yesno' && r.answer.p).toBeCloseTo(0.95, 6);
    expect(r.calls).toEqual({ decide: 2, explain: 0, why: 0 });
    expect(backend.calls).toHaveLength(2);
    // The state carries file:line headers.
    expect(String(backend.calls[0]!.state)).toMatch(/^### src\/auth\/session\.ts:1-3\n/);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as DecisionRecord;
    expect(rec).toMatchObject({ questionId: 'q', backend: 'fake', stateHash: r.record.stateHash });
    expect(rec.explain).toBeUndefined();
  });

  it('explains: highlights the expiry check, reasons, summary with call path, and a why', async () => {
    const backend = new FakeBackend({
      rules: [
        expiryRule,
        (ctx) => (ctx.questionId === 'reason:changes-behavior' ? 0.9 : undefined),
        (ctx) => (ctx.questionId === 'reason:missing-check' ? 0.05 : undefined),
      ],
      generate: () => 'WHY: expired sessions are revoked and rejected\nH1: rejects sessions past their expiry time',
    });
    const r = await ask({ paths: ['src/auth/session.ts', 'src/auth/middleware.ts'] }, 'Do sessions expire?', {
      backend,
      root: FIXTURE,
      log: false,
      explain: { topK: 40, budget: 100 },
      reasons: parseReasons(['changes-behavior', 'missing-check']),
      why: true,
    });
    const ex = r.explain!;
    expect(ex.highlights).toHaveLength(1);
    const h = ex.highlights[0]!;
    expect(h.file).toBe('src/auth/session.ts');
    expect(h.startLine).toBeLessThanOrEqual(41);
    expect(h.endLine).toBeGreaterThanOrEqual(41);
    expect(h.deltaP).toBeCloseTo(0.3 - 0.95, 3);
    expect(h.comment).toBe('rejects sessions past their expiry time');
    expect(ex.why).toEqual({ text: 'expired sessions are revoked and rejected', kind: 'narrative' });
    expect(ex.reasons[0]).toEqual({ code: 'changes-behavior', p: expect.closeTo(0.9, 6), kind: 'causal' });
    // requireAuth calls verifySession, which holds the highlight.
    expect(ex.summary[0]).toMatch(/^requireAuth\(\) -> verifySession\(\)\s+# rejects sessions past their expiry time$/);
    expect(ex.summary).toContain('ruled out: missing-check (p=0.05)');
    expect(r.explainStats).toMatchObject({ tested: r.chunks.length, baselineP: expect.closeTo(0.95, 6) });
    expect(r.calls.explain).toBe(2 + 2 * r.chunks.length);
    expect(r.calls.why).toBe(1);

    const pretty = renderPretty(r);
    expect(pretty.split('\n')[0]).toMatch(/^YES {2}p=0\.95 {2}conf=0\.90 {2}act {3}"Do sessions expire\?"$/);
    expect(pretty).toContain('summary\n  requireAuth() -> verifySession()');
    expect(pretty).toMatch(/highlights\n {2}src\/auth\/session\.ts:\d+(-\d+)? +Δp -0\.65 {2}# rejects sessions/);
    expect(pretty).toContain('why  expired sessions are revoked and rejected');
    const json = JSON.parse(renderJson(r)) as { label: string; explain: { highlights: unknown[] } };
    expect(json.label).toBe('YES');
    expect(json.explain.highlights).toHaveLength(1);
  });

  it('keeps the decision the same with and without explain', async () => {
    const mk = () => new FakeBackend({ rules: [expiryRule], seed: 5 });
    const plain = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', { backend: mk(), root: FIXTURE, log: false });
    const explained = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', {
      backend: mk(),
      root: FIXTURE,
      log: false,
      explain: true,
    });
    expect(explained.answer).toEqual(plain.answer);
  });

  it('respects the explain budget, the hidden batch included', async () => {
    const backend = new FakeBackend({ rules: [expiryRule] });
    const r = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', {
      backend,
      root: FIXTURE,
      log: false,
      explain: { budget: 6 },
      why: false,
    });
    expect(r.calls.explain).toBeLessThanOrEqual(6);
    expect(backend.calls.length).toBe(r.calls.decide + r.calls.explain);
    expect(r.explainStats!.tested).toBe(2);
  });

  it('generates the why automatically only when the band is not act', async () => {
    const unsure = new FakeBackend({ rules: [() => 0.6], generate: () => 'WHY: hard to tell from this code' });
    const r = await ask({ paths: ['src/db.ts'] }, 'Is this safe?', { backend: unsure, root: FIXTURE, log: false });
    expect(r.answer.band).toBe('escalate');
    expect(r.explain?.why?.text).toBe('hard to tell from this code');
    expect(r.explain?.highlights).toEqual([]);

    const sure = new FakeBackend({ rules: [() => 0.99] });
    const s = await ask({ paths: ['src/db.ts'] }, 'Is this safe?', { backend: sure, root: FIXTURE, log: false });
    expect(s.explain).toBeUndefined();
    expect(sure.generated).toHaveLength(0);
  });

  it('asks over a diff and over node ids', async () => {
    const diff = [
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -11,1 +11,1 @@',
      '-const SESSION_TTL_MS = 3600 * 1000;',
      '+const SESSION_TTL_MS = Number(process.env.SESSION_TTL) * 1000;',
    ].join('\n');
    const backend = new FakeBackend({ rules: [(ctx) => (ctx.text.includes('+const SESSION_TTL_MS') ? 0.9 : 0.1)] });
    const r = await ask({ diff }, 'Does this change auth behavior?', { backend, root: FIXTURE, log: false, explain: true, why: false });
    expect(r.chunks[0]).toMatchObject({ file: 'src/auth/session.ts', startLine: 11, diff: true });
    expect(String(backend.calls[0]!.state)).toContain('### src/auth/session.ts:11 (diff)');
    expect(r.explain!.highlights[0]).toMatchObject({ file: 'src/auth/session.ts', startLine: 11, endLine: 11 });

    const n = await ask({ nodes: ['src/auth/session.ts#verifySession'] }, 'q?', { backend, root: FIXTURE, log: false, why: false });
    expect(n.chunks.every((c) => c.startLine >= 38 && c.endLine <= 46)).toBe(true);
  });

  it('writes to <root>/.glassbox/decisions.jsonl by default and appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glassbox-root-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'a.py'), 'def f():\n    return 1\n');
    const backend = new FakeBackend();
    await ask({ paths: ['a.py'] }, 'q?', { backend, root, why: false });
    const r = await ask({ paths: ['a.py'] }, 'q?', { backend, root, why: false });
    expect(r.logFile).toBe(join(root, '.glassbox', 'decisions.jsonl'));
    expect((await readFile(r.logFile!, 'utf8')).trim().split('\n')).toHaveLength(2);
    await appendDecisionLog(r.logFile!, r.record);
    expect((await readFile(r.logFile!, 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('renders choice and score answers', async () => {
    const backend = new FakeBackend({ rules: [() => ({ bug: 3, feature: 1 })] });
    const c = await ask({ paths: ['src/db.ts'] }, makeQuestion('kind?', 'choice', ['bug', 'feature']), { backend, root: FIXTURE, log: false, why: false });
    expect(renderPretty(c)).toMatch(/^bug {2}p=0\.75 /);
    expect(renderPretty(c)).toContain('options  bug 0.75   feature 0.25');
    const s = await ask({ paths: ['src/db.ts'] }, makeQuestion('risk?', 'score', ['low', 'high']), {
      backend: new FakeBackend({ rules: [() => ({ '0': 1, '1': 3 })] }),
      root: FIXTURE,
      log: false,
      why: false,
    });
    expect(renderPretty(s)).toMatch(/^SCORE 0\.75\/1 \(level 1: high\) {2}p=0\.75 /);
    // The options line names the levels instead of printing their indexes.
    expect(renderPretty(s)).toContain('options  low 0.25   high 0.75');
  });

  it('logs a diff scope as its files and hash, not the diff text', async () => {
    const diff = [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -11,1 +11,1 @@',
      '-const TOKEN = "old-secret-value";',
      '+const TOKEN = "new-secret-value";',
      '',
    ].join('\n');
    const r = await ask({ diff }, 'Does this change auth?', { backend: new FakeBackend(), root: FIXTURE, log: await tmpLog(), why: false });
    const logged = await readFile(r.logFile!, 'utf8');
    expect(logged).not.toContain('secret-value');
    expect(r.record.scope).toEqual({ diffFiles: ['src/auth/session.ts'], diffHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
