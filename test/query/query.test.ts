import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ask, readDecisionLog } from '../../src/ask.js';
import { FakeBackend, type FakeRule } from '../../src/backends/fake.js';
import { indexRepo } from '../../src/memory/source.js';
import { GraphStore } from '../../src/memory/store.js';
import { buildAgentsSummary, syncMd } from '../../src/memory/summary.js';
import { tagPass } from '../../src/memory/tags.js';
import { decide } from '../../src/query/decide.js';
import { calibrateFromLog, labelDecision } from '../../src/calibrate/store.js';
import { explainDecision, findDecision } from '../../src/query/explain.js';
import { lexicalScore, queryTerms, termsMatch, tokenize } from '../../src/query/lexical.js';
import { renderDecide, renderTriage, renderWhere } from '../../src/query/render.js';
import { triage } from '../../src/query/triage.js';
import { where } from '../../src/query/where.js';
import type { DecisionRecord } from '../../src/types.js';
import { sha256 } from '../../src/util/hash.js';
import { fixtureCopy, tagRule } from './helpers.js';

let root: string;
let store: GraphStore;

beforeAll(async () => {
  root = await fixtureCopy();
  store = GraphStore.open(root);
  await indexRepo(root, store);
  await tagPass(root, new FakeBackend({ rules: [tagRule] }), { store, groupSize: 4 });
});

afterAll(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe('lexical prefilter', () => {
  it('splits identifiers and drops stopwords', () => {
    expect(tokenize('retryCharge in src/billing/stripe_client.ts')).toEqual(['retry', 'charge', 'in', 'src', 'billing', 'stripe', 'client', 'ts']);
    expect(queryTerms('Where is the billing retried?')).toEqual(['billing', 'retried']);
  });

  it('matches plurals and tenses but not unrelated short words', () => {
    expect(termsMatch('retried', 'retry')).toBe(true);
    expect(termsMatch('billing', 'bill')).toBe(true);
    expect(termsMatch('sessions', 'session')).toBe(true);
    expect(termsMatch('db', 'db')).toBe(true);
    expect(termsMatch('user', 'use')).toBe(true);
    expect(termsMatch('charge', 'change')).toBe(false);
    expect(termsMatch('pay', 'payment')).toBe(false);
  });

  it('weighs names over paths over bodies, and boosts matching tags', () => {
    const node = { id: 'src/billing/retry.ts#retryCharge', name: 'retryCharge', file: 'src/billing/retry.ts' };
    expect(lexicalScore(['retry'], { node })).toBe(3);
    expect(lexicalScore(['billing'], { node })).toBe(2);
    expect(lexicalScore(['backoff'], { node, text: 'exponential backoff' })).toBe(1);
    const tag = { nodeId: node.id, questionId: 'handles_auth', answer: 'true', p: 0.5, confidence: 0, hash: '' };
    expect(lexicalScore(['login'], { node, tags: [tag] })).toBe(1);
  });
});

describe('where', () => {
  const whereRule: FakeRule = (ctx) =>
    ctx.questionId.startsWith('where:') ? (ctx.question.instructions.includes('retry.ts:7-18') ? 0.95 : 0.15) : undefined;

  it('prefilters by words and tags, then ranks with one batched yes/no per candidate', async () => {
    const backend = new FakeBackend({ rules: [whereRule] });
    const r = await where('where are billing charges retried?', { store, root, backend, candidates: 6, top: 3 });
    expect(r.hits[0]).toMatchObject({ nodeId: 'src/billing/retry.ts#retryCharge', startLine: 7, endLine: 18 });
    expect(r.hits[0]!.p).toBeCloseTo(0.95, 6);
    expect(r.hits).toHaveLength(3);
    expect(r.asked).toBe(6);
    expect(r.calls).toBe(2);
    // Every candidate went into one state with its own question.
    expect(Object.keys(backend.calls[0]!.questions)).toHaveLength(6);
    expect(renderWhere(r)).toMatch(/p=0\.95 +src\/billing\/retry\.ts:7-18 +retryCharge \(function\)/);
  });

  it('returns no hits without calling the model when nothing matches', async () => {
    const backend = new FakeBackend();
    const r = await where('quaternion slerp', { store, root, backend });
    expect(r).toMatchObject({ hits: [], matched: 0, calls: 0 });
    expect(backend.calls).toHaveLength(0);
    await expect(where('the of and', { store, root, backend })).rejects.toThrow(/searchable words/);
  });
});

const DIFF = [
  'diff --git a/src/auth/session.ts b/src/auth/session.ts',
  '--- a/src/auth/session.ts',
  '+++ b/src/auth/session.ts',
  '@@ -40,3 +40,3 @@',
  '   if (!session) return null;',
  '-  if (session.expiresAt < Date.now()) {',
  '+  if (session.expiresAt <= Date.now()) {',
  '     store.revoke(token);',
  'diff --git a/src/ui/format.ts b/src/ui/format.ts',
  '--- a/src/ui/format.ts',
  '+++ b/src/ui/format.ts',
  '@@ -5,1 +5,1 @@',
  '-export const formatDate = (ms: number): string => new Date(ms).toISOString();',
  '+export const formatDate = (ms: number): string => new Date(ms).toUTCString();',
  '',
].join('\n');

/** Risk follows the expiry change: High while its hunk is in the state, Low without it. */
const riskRule: FakeRule = (ctx) => {
  // Re-asks during hide-and-re-ask use another question id, so match on the text.
  if (ctx.question.instructions.startsWith('How risky is this change overall')) return ctx.text.includes('expiresAt') ? { '0': 0.1, '1': 0.2, '2': 0.7 } : { '0': 0.8, '1': 0.15, '2': 0.05 };
  if (ctx.questionId.startsWith('hunk:')) {
    return ctx.question.instructions.includes('session.ts') ? { '0': 0.1, '1': 0.1, '2': 0.8 } : { '0': 0.9, '1': 0.05, '2': 0.05 };
  }
  if (ctx.questionId === 'reason:auth-or-permissions') return 0.9;
  return undefined;
};

describe('triage', () => {
  let r: Awaited<ReturnType<typeof triage>>;
  let backend: FakeBackend;

  beforeAll(async () => {
    backend = new FakeBackend({ rules: [riskRule] });
    r = await triage(DIFF, { store, root, backend });
  });

  it('scores each hunk and maps it to the nodes it touches', () => {
    expect(r.level).toBe('High');
    expect(r.hunks).toHaveLength(2);
    expect(r.hunks[0]).toMatchObject({ file: 'src/auth/session.ts', level: 'High', nodes: ['src/auth/session.ts#verifySession'] });
    expect(r.hunks[1]).toMatchObject({ file: 'src/ui/format.ts', level: 'Low', nodes: ['src/ui/format.ts#formatDate'] });
    expect(r.hunks[0]!.p).toBeCloseTo(0.8, 6);
  });

  it('puts stored tags of the touched code into the question', () => {
    const q = Object.values(backend.calls[0]!.questions).find((x) => x.question.instructions.startsWith('How risky is this change overall'));
    expect(q?.question.instructions).toContain('verifySession (src/auth/session.ts:38): ');
    expect(q?.question.instructions).toContain('handles_auth=yes 0.90');
  });

  it('follows call edges one hop to the affected callers', () => {
    expect(r.affected).toEqual([
      { nodeId: 'src/auth/middleware.ts#requireAuth', file: 'src/auth/middleware.ts', line: 11, name: 'requireAuth', via: 'src/auth/session.ts#verifySession', edge: 'calls' },
      { nodeId: 'src/ui/InvoiceTable.tsx#InvoiceTable', file: 'src/ui/InvoiceTable.tsx', line: 9, name: 'InvoiceTable', via: 'src/ui/format.ts#formatDate', edge: 'calls' },
    ]);
  });

  it('backs the answer with a causal highlight, reasons and a summary', () => {
    expect(r.explain.highlights).toHaveLength(1);
    expect(r.explain.highlights[0]).toMatchObject({ file: 'src/auth/session.ts', startLine: 40, kind: 'causal' });
    expect(r.explain.highlights[0]!.deltaP).toBeCloseTo(0.05 - 0.7, 6);
    expect(r.explain.reasons.find((x) => x.code === 'auth-or-permissions')?.p).toBeCloseTo(0.9, 6);
    // The summary walks from the caller the graph knows about.
    expect(r.explain.summary[0]).toMatch(/^requireAuth\(\) -> verifySession\(\) +# Δp -0\.65 at src\/auth\/session\.ts:40-42$/);
    // The riskiest hunk is hidden first; the budget is respected.
    expect(r.explain.stats!.calls).toBeLessThanOrEqual(12);
    const pretty = renderTriage(r);
    expect(pretty).toMatch(/^RISK High {2}p=0\.70/);
    expect(pretty).toContain('affected (one hop)');
    expect(pretty).toMatch(/src\/auth\/middleware\.ts:11 +requireAuth +calls src\/auth\/session\.ts#verifySession/);
  });

  it('logs the overall decision with the diff\'s files and hash, never its text', async () => {
    const records = await readDecisionLog(join(root, '.glassbox', 'decisions.jsonl'));
    const rec = records.find((x) => x.id === r.record.id)!;
    expect(rec).toMatchObject({ source: 'triage', questionId: 'risk' });
    expect(rec.scope).toEqual({ diffFiles: ['src/auth/session.ts', 'src/ui/format.ts'], diffHash: sha256(DIFF) });
    expect(JSON.stringify(rec)).not.toContain('expiresAt <= Date.now()');
    expect(rec.explain?.highlights).toHaveLength(1);
  });

  it('re-explains a hash-only triage record only when given the same diff', async () => {
    const logFile = join(root, '.glassbox', 'triage-hash.jsonl');
    const b = new FakeBackend({ rules: [riskRule] });
    const t = await triage(DIFF, { store, root, backend: b, explain: false, log: logFile });
    const same = await explainDecision(t.record.id!, { root, backend: () => b, store: () => store, logFile, diff: async () => DIFF });
    expect(same.cached).toBe(false);
    expect(same.changed).toBe(false);
    await expect(
      explainDecision(t.record.id!, { root, backend: () => b, store: () => store, logFile, refresh: true, diff: async () => `${DIFF}\n+x\n` }),
    ).rejects.toThrow(/only a hash of the diff .*src\/auth\/session\.ts/);
  });

  it('never sends diff chunks of secret-looking files', async () => {
    const secret = ['diff --git a/.env b/.env', '--- a/.env', '+++ b/.env', '@@ -1,1 +1,1 @@', '-API_KEY=old', '+API_KEY=sk-live-123', ''].join('\n');
    const b = new FakeBackend({ rules: [riskRule] });
    const logFile = join(root, '.glassbox', 'secret-names.jsonl');
    const mixed = await triage(secret + DIFF, { store, root, backend: b, explain: false, log: logFile });
    // The secret file's name is not logged either, only a placeholder.
    expect(mixed.record.scope?.diffFiles).toEqual(['<secret file omitted>', 'src/auth/session.ts', 'src/ui/format.ts']);
    expect(await readFile(logFile, 'utf8')).not.toContain('.env');
    expect(mixed.hunks.map((h) => h.file)).toEqual(['src/auth/session.ts', 'src/ui/format.ts']);
    expect(JSON.stringify(b.calls)).not.toContain('sk-live-123');
    await expect(triage(secret, { store, root, backend: b, log: false })).rejects.toThrow(/may hold secrets/);
  });

  it('treats a pure rename as a change to the file node, so its importers are affected', async () => {
    const rename = [
      'diff --git a/src/ui/format.ts b/src/ui/formatting.ts',
      'similarity index 100%',
      'rename from src/ui/format.ts',
      'rename to src/ui/formatting.ts',
      '',
    ].join('\n');
    const b = new FakeBackend({ rules: [riskRule] });
    const moved = await triage(rename, { store, root, backend: b, explain: false, log: false });
    expect(moved.hunks).toHaveLength(1);
    expect(moved.hunks[0]).toMatchObject({ file: 'src/ui/formatting.ts', nodes: ['src/ui/format.ts'] });
    expect(moved.affected).toContainEqual(
      expect.objectContaining({ file: 'src/ui/InvoiceTable.tsx', via: 'src/ui/format.ts', edge: 'imports' }),
    );
  });

  it('maps a hunk to nodes by its changed lines, not its context lines', async () => {
    const append = [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -50,3 +50,6 @@',
      '   if (!user || !comparePassword(password, String(user.passwordHash))) return null;',
      '   return issueToken(String(user.id));',
      ' }',
      '+',
      '+export const MAX_SESSIONS = 5;',
      '',
    ].join('\n');
    const quick = await triage(append, { store, root, backend: new FakeBackend({ rules: [riskRule] }), explain: false, log: false });
    expect(quick.hunks[0]!.nodes).toEqual(['src/auth/session.ts']);
    expect(quick.affected.some((a) => a.via === 'src/auth/session.ts#login')).toBe(false);
  });

  it('skips evidence with explain: false and rejects an empty diff', async () => {
    const b = new FakeBackend({ rules: [riskRule] });
    const quick = await triage(DIFF, { store, root, backend: b, explain: false, log: false });
    expect(quick.calls).toEqual({ decide: 2, explain: 0 });
    expect(quick.explain).toEqual({ highlights: [], reasons: [], summary: [] });
    await expect(triage('', { store, root, backend: b })).rejects.toThrow(/no changed lines/);
  });
});

describe('decide', () => {
  it('advises between options with graph context and logs the decision', async () => {
    const backend = new FakeBackend({ rules: [(ctx) => (ctx.questionId === 'q' ? { session: 3, config: 1 } : undefined)] });
    const r = await decide(
      'Where should the session TTL default live?',
      ['config=a shared config module', 'session=next to the session code'],
      'The TTL is read from env with no fallback today.',
      { store, root, backend },
    );
    expect(r).toMatchObject({ choice: 'session', advisory: true, band: expect.any(String) });
    expect(r.probabilities.session).toBeCloseTo(0.75, 6);
    expect(r.context).toContain('src/auth/session.ts#verifySession');
    const state = String(backend.calls[0]!.state);
    expect(state).toContain('## Context from the agent\nThe TTL is read from env with no fallback today.');
    expect(state).toMatch(/tags: .*handles_auth=yes 0\.90/);
    expect(renderDecide(r)).toMatch(/^session {2}p=0\.75 .*\noptions {2}config 0\.25 {3}session 0\.75\nadvice only/);
    const records = await readDecisionLog(join(root, '.glassbox', 'decisions.jsonl'));
    expect(records.find((x) => x.id === r.record.id)).toMatchObject({ source: 'decide' });
  });

  it('re-explains a decide record over its own state (hint, tags, excerpts), not the nodes\' source', async () => {
    const logFile = join(root, '.glassbox', 'decide-explain.jsonl');
    const HINT = 'The TTL is read from env with no fallback today.';
    // The answer depends on the hint and on stored tags, which only decide's own state holds.
    const rule: FakeRule = (ctx) => {
      if (ctx.questionId !== 'q') return undefined;
      const hinted = ctx.text.includes('no fallback today');
      const tagged = /tags: .*handles_auth=yes/.test(ctx.text);
      return hinted && tagged ? { session: 9, config: 1 } : hinted ? { session: 6, config: 4 } : { session: 1, config: 4 };
    };
    const backend = new FakeBackend({ rules: [rule] });
    const r = await decide(
      'Where should the session TTL default live?',
      ['config=a shared config module', 'session=next to the session code'],
      HINT,
      { store, root, backend, log: logFile },
    );
    expect(r.choice).toBe('session');
    expect(r.record.scope).toMatchObject({ context: HINT });

    const ex = await explainDecision(r.record.id!, { root, backend: () => backend, store: () => store, budget: 20, logFile });
    expect(ex.changed).toBe(false);
    // Every re-ask ran over decide's layout, never over plain ### file:line chunks of source.
    for (const call of backend.calls) expect(String(call.state)).not.toMatch(/^### [^\n]+\n(?!tags:)/);
    // Hiding the hint flips the answer, so it is the strongest highlight.
    expect(ex.explain.highlights[0]).toMatchObject({ file: '(agent context)', startLine: 1, endLine: 1 });
    expect(ex.explain.highlights[0]!.deltaP).toBeLessThan(-0.5);
    expect(ex.explain.stats?.tested).toBeGreaterThan(1);

    await expect(explainDecision(r.record.id!, { root, backend: () => backend, logFile, refresh: true })).rejects.toThrow(
      /needs the graph store/,
    );
  });

  it('works without a store and needs two options', async () => {
    const backend = new FakeBackend();
    const r = await decide('A or B?', ['a', 'b'], undefined, { root, backend, log: false });
    expect(r.context).toEqual([]);
    expect(String(backend.calls[0]!.state)).toBe('(no extra context)');
    await expect(decide('Only one?', ['a'], undefined, { root, backend, log: false })).rejects.toThrow(/at least 2 options/);
  });
});

describe('explainDecision', () => {
  const EXPIRY = 'session.expiresAt < Date.now()';
  const expiryRule: FakeRule = (ctx) => (ctx.questionId === 'q' ? (ctx.text.includes(EXPIRY) ? 0.95 : 0.3) : undefined);

  it('re-asks a logged ask decision with evidence, appends it, then serves it from the log', async () => {
    const backend = new FakeBackend({ rules: [expiryRule] });
    const asked = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', { backend, root, why: false });
    const id = asked.record.id!;
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(asked.record.scope).toEqual({ paths: ['src/auth/session.ts'] });

    const r = await explainDecision(id.slice(0, 6), { root, backend: () => backend, budget: 100 });
    expect(r.cached).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.explain.highlights[0]).toMatchObject({ file: 'src/auth/session.ts', startLine: 38, endLine: 45 });
    const log = (await readFile(join(root, '.glassbox', 'decisions.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(log.at(-1)!)).toMatchObject({ id, explain: { highlights: expect.any(Array) } });

    const calls = backend.calls.length;
    const again = await explainDecision(id, { root });
    expect(again.cached).toBe(true);
    expect(again.explain).toEqual(r.explain);
    expect(backend.calls.length).toBe(calls);
  });

  it('adds evidence to an ask that was logged with only a one-line why', async () => {
    const backend = new FakeBackend({ rules: [expiryRule] });
    const logFile = join(root, '.glassbox', 'why-only.jsonl');
    const asked = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', { backend, root, why: true, log: logFile });
    const why = asked.record.explain?.why;
    expect(why).toBeTruthy();
    expect(asked.record.explain?.highlights ?? []).toEqual([]);

    const r = await explainDecision(asked.record.id!, { root, backend: () => backend, budget: 100, logFile });
    expect(r.cached).toBe(false);
    expect(r.explain.highlights.length).toBeGreaterThan(0);
    expect(r.explain.why).toEqual(why);
  });

  it('counts an explained and labeled decision once when calibrating', async () => {
    const backend = new FakeBackend({ rules: [expiryRule] });
    const logFile = join(root, '.glassbox', 'calib-once.jsonl');
    const asked = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', { backend, root, why: false, log: logFile });
    const id = asked.record.id!;
    await explainDecision(id, { root, backend: () => backend, budget: 100, logFile });
    await labelDecision(root, id, 'yes', logFile);
    const report = await calibrateFromLog(root, { dryRun: true, logFile });
    expect(report.labeled).toBe(1);
    expect(report.entries[0]!.n).toBe(1);
  });

  it('refuses to attach evidence when the re-ask flips the logged answer', async () => {
    const logFile = join(root, '.glassbox', 'flip.jsonl');
    const yes = new FakeBackend({ rules: [(ctx) => (ctx.questionId === 'q' ? 0.9 : undefined)] });
    const no = new FakeBackend({ rules: [(ctx) => (ctx.questionId === 'q' ? 0.1 : undefined)] });
    const asked = await ask({ paths: ['src/auth/session.ts'] }, 'Do sessions expire?', { backend: yes, root, why: false, log: logFile });
    await expect(explainDecision(asked.record.id!, { root, backend: () => no, budget: 4, logFile })).rejects.toThrow(/different answer/);
    expect((await readFile(logFile, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('finds ids by unique prefix and reports unknown or ambiguous ones', async () => {
    const recs = [{ id: 'abcd1111' }, { id: 'abcd2222' }, { id: 'ffff0000' }] as DecisionRecord[];
    expect(findDecision(recs, 'ffff')?.id).toBe('ffff0000');
    expect(() => findDecision(recs, 'abcd')).toThrow(/ambiguous/);
    expect(() => findDecision(recs, 'ab')).toThrow(/at least 4/);
    await expect(explainDecision('00000000', { root })).rejects.toThrow(/no decision/);
  });
});

describe('AGENTS.md summary', () => {
  it('builds areas, entry points and risky nodes from the tags', () => {
    const s = buildAgentsSummary(store, new Date('2026-01-01T00:00:00Z'));
    const auth = s.areas.find((a) => a.name === 'auth')!;
    expect(auth.nodeCount).toBe(10);
    // Called from the api area: login, requireAuth, requireAdmin. verifySession is only called inside auth.
    expect(auth.entryPoints.sort()).toEqual(['src/auth/middleware.ts:11', 'src/auth/middleware.ts:24', 'src/auth/session.ts:48']);
    expect(s.areas.map((a) => a.name)).toEqual(expect.arrayContaining(['api', 'billing', 'ui', 'worker']));
    // Equal risk, so the node with the most callers comes first.
    const first = s.riskyNodes[0]!;
    expect(first).toMatchObject({ name: 'requireAuth', file: 'src/auth/middleware.ts', line: 11, reason: expect.stringMatching(/^high risk, auth/) });
    expect(first.p).toBeCloseTo(0.8, 6);
    expect(s.riskyNodes.some((n) => n.name === 'formatDate')).toBe(false);
    expect(s.riskyNodes.length).toBeLessThanOrEqual(10);
    expect(s.availableTags).toEqual(['area', 'handles_auth', 'needs_tests', 'risk', 'side_effects', 'touches_pii']);
  });

  it('writes the managed block and the CLAUDE.md import, idempotently', async () => {
    const first = await syncMd(root, store);
    expect(first).toMatchObject({ agentsMd: 'created', claudeMd: 'created' });
    expect(first.lines).toBeLessThanOrEqual(60);
    const md = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(md).toContain('<!-- glassbox:start -->');
    expect(md).toMatch(/- `auth` \(10 nodes\)/);
    expect(md).toMatch(/\n- `requireAuth` `src\/auth\/middleware\.ts:11` p=0\.80: high risk, auth/);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    const second = await syncMd(root, store);
    expect(second).toMatchObject({ agentsMd: 'unchanged', claudeMd: 'unchanged' });
  });
});
