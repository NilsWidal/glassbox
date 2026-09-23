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
import { explainDecision, findDecision } from '../../src/query/explain.js';
import { lexicalScore, queryTerms, termsMatch, tokenize } from '../../src/query/lexical.js';
import { renderDecide, renderTriage, renderWhere } from '../../src/query/render.js';
import { triage } from '../../src/query/triage.js';
import { where } from '../../src/query/where.js';
import type { DecisionRecord } from '../../src/types.js';
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

  it('logs the overall decision with its diff so it can be explained later', async () => {
    const records = await readDecisionLog(join(root, '.glassbox', 'decisions.jsonl'));
    const rec = records.find((x) => x.id === r.record.id)!;
    expect(rec).toMatchObject({ source: 'triage', questionId: 'risk', scope: { diff: DIFF } });
    expect(rec.explain?.highlights).toHaveLength(1);
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
    expect(md).toMatch(/- \*\*auth\*\* \(10 nodes\)/);
    expect(md).toMatch(/\n- `requireAuth` src\/auth\/middleware\.ts:11 p=0\.80: high risk, auth/);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    const second = await syncMd(root, store);
    expect(second).toMatchObject({ agentsMd: 'unchanged', claudeMd: 'unchanged' });
  });
});
