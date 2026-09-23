import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backends/fake.js';
import { validateQuestion } from '../../src/engine/questions.js';
import { indexRepo } from '../../src/memory/source.js';
import { GraphStore } from '../../src/memory/store.js';
import {
  OTHER_AREA,
  areaOf,
  defaultTagQuestions,
  inferAreas,
  isTagTarget,
  nodeTagLabels,
  tagPass,
  type TagProgress,
} from '../../src/memory/tags.js';
import { fixtureCopy, tagRule } from '../query/helpers.js';

describe('areas', () => {
  it('names an area after the first directory that is not generic', () => {
    expect(areaOf('src/auth/session.ts')).toBe('auth');
    expect(areaOf('packages/Web-App/src/x.ts')).toBe('web-app');
    expect(areaOf('worker/main.py')).toBe('worker');
    expect(areaOf('src/db.ts')).toBeUndefined();
    expect(areaOf('index.ts')).toBeUndefined();
  });

  it('infers areas by file count, capped, always ending with other', () => {
    const files = ['src/auth/a.ts', 'src/auth/b.ts', 'src/ui/c.ts', 'worker/d.py', 'src/db.ts'];
    expect(inferAreas(files)).toEqual(['auth', 'ui', 'worker', OTHER_AREA]);
    expect(inferAreas(files, 1)).toEqual(['auth', OTHER_AREA]);
    expect(inferAreas([])).toEqual([OTHER_AREA]);
  });

  it('builds a valid default question set', () => {
    const qs = defaultTagQuestions(['auth', 'billing', OTHER_AREA]);
    expect(Object.keys(qs)).toEqual(['handles_auth', 'side_effects', 'touches_pii', 'needs_tests', 'area', 'risk']);
    for (const [id, q] of Object.entries(qs)) validateQuestion(id, q);
    expect(qs.area).toMatchObject({ type: 'choice' });
    expect(Object.keys((qs.area as { criteria: Record<string, string> }).criteria)).toEqual(['auth', 'billing', OTHER_AREA]);
    expect(qs.risk).toMatchObject({ type: 'score', criteria: ['Low', 'Medium', 'High'] });
    // A flat repo has no areas to choose from, so the question is left out.
    expect(Object.keys(defaultTagQuestions(inferAreas(['a.ts', 'b.ts'])))).not.toContain('area');
  });
});

describe('tagPass on the sample repo', () => {
  let root: string;
  let store: GraphStore;

  beforeEach(async () => {
    root = await fixtureCopy();
    store = GraphStore.open(root);
    await indexRepo(root, store);
  });
  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('tags every target once, then serves them from the cache', async () => {
    const targets = store.getNodes().filter(isTagTarget);
    expect(targets.length).toBeGreaterThan(40);
    expect(targets.some((n) => n.kind === 'class')).toBe(false);
    // session.ts is over the small-file limit, so only its functions and methods are targets.
    expect(targets.some((n) => n.id === 'src/auth/session.ts')).toBe(false);

    const backend = new FakeBackend({ rules: [tagRule] });
    const progress: TagProgress[] = [];
    const first = await tagPass(root, backend, { store, groupSize: 1, onProgress: (p) => progress.push(p) });
    expect(first).toMatchObject({ targets: targets.length, asked: targets.length, cached: 0, deferred: 0, failed: [] });
    expect(first.tags).toBe(targets.length * 6);
    // One state per node, two option orders each.
    expect(first.calls).toBe(targets.length * 2);
    expect(progress.at(-1)).toMatchObject({ done: targets.length, total: targets.length });
    expect(store.staleNodes()).toEqual([]);

    expect(store.getTag('src/auth/session.ts#verifySession', 'handles_auth')).toMatchObject({ answer: 'true' });
    expect(store.getTag('src/auth/session.ts#verifySession', 'area')).toMatchObject({ answer: 'auth' });
    expect(store.getTag('src/auth/session.ts#verifySession', 'risk')).toMatchObject({ answer: '2' });
    expect(store.getTag('src/ui/format.ts#formatDate', 'risk')).toMatchObject({ answer: '0' });
    expect(nodeTagLabels(store, 'src/auth/session.ts#verifySession')).toContain('risk=High 0.80');

    const calls = backend.calls.length;
    const second = await tagPass(root, backend, { store, groupSize: 1 });
    expect(second).toMatchObject({ asked: 0, cached: targets.length, calls: 0 });
    expect(backend.calls.length).toBe(calls);
  });

  it('re-asks only changed nodes and their one-hop dependents after an edit', async () => {
    const backend = new FakeBackend({ rules: [tagRule] });
    await tagPass(root, backend, { store, groupSize: 1 });
    const file = join(root, 'src/auth/session.ts');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('session.expiresAt < Date.now()', 'session.expiresAt <= Date.now()'));
    const { sync } = await indexRepo(root, store);
    expect(sync.changed).toContain('src/auth/session.ts#verifySession');

    const before = backend.calls.length;
    const r = await tagPass(root, backend, { store, groupSize: 1 });
    const asked = new Set(
      backend.calls.slice(before).map((c) => /^### ([^ ]+) \((\w+) ([^)]+)\)/.exec(String(c.state))!).map((m) => m[3]),
    );
    expect(asked.has('verifySession')).toBe(true);
    // requireAuth calls verifySession, so its tags may be out of date too.
    expect(asked.has('requireAuth')).toBe(true);
    expect(asked.has('formatDate')).toBe(false);
    expect(r.asked).toBeLessThan(r.targets / 3);
    expect(r.cached).toBe(r.targets - r.asked);
    expect(store.staleNodes()).toEqual([]);
  });

  it('groups several nodes per call and keeps each answer with its node', async () => {
    const backend = new FakeBackend({ rules: [tagRule] });
    const r = await tagPass(root, backend, { store, groupSize: 4 });
    expect(r.calls).toBe(Math.ceil(r.asked / 4) * 2);
    expect(store.getTag('src/auth/session.ts#verifySession', 'handles_auth')?.answer).toBe('true');
    expect(store.getTag('src/billing/retry.ts#retryCharge', 'handles_auth')?.answer).toBe('false');
    expect(store.getTag('src/billing/retry.ts#retryCharge', 'area')?.answer).toBe('billing');
    expect(store.getTag('worker/main.py#run', 'area')?.answer).toBe('worker');
    const q = Object.values(backend.calls[0]!.questions)[0]!.question.instructions;
    expect(q).toMatch(/^About the code under the header ".+" only: /);
  });

  it('keeps failed and deferred nodes stale for the next run', async () => {
    const backend = new FakeBackend({ rules: [tagRule], failCalls: [0, 1] });
    const r = await tagPass(root, backend, { store, groupSize: 1, concurrency: 1, limit: 5 });
    expect(r.asked).toBe(5);
    expect(r.deferred).toBe(r.targets - 5);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.error).toContain('fake failure');
    const failedId = r.failed[0]!.nodeIds[0]!;
    expect(store.getNode(failedId)?.stale).toBe(true);
    expect(store.getTags(failedId)).toEqual([]);

    const again = await tagPass(root, new FakeBackend({ rules: [tagRule] }), { store, groupSize: 1 });
    expect(again.asked).toBe(r.targets - 4);
    expect(again.failed).toEqual([]);
    expect(store.getTags(failedId)).toHaveLength(6);
  });

  it('re-asks everything with force', async () => {
    const backend = new FakeBackend({ rules: [tagRule] });
    const first = await tagPass(root, backend, { store, groupSize: 8 });
    const forced = await tagPass(root, backend, { store, groupSize: 8, force: true });
    expect(forced.asked).toBe(first.targets);
    expect(forced.cached).toBe(0);
  });
});
