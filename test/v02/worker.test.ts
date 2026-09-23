import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicBackend } from '../../src/backends/anthropic.js';
import { FakeBackend } from '../../src/backends/fake.js';
import { OpenAICompatBackend } from '../../src/backends/openai-compat.js';
import type { Backend } from '../../src/types.js';
import { refresh } from '../../src/memory/refresh.js';
import { renderStatus, status } from '../../src/status.js';
import {
  WORKER_LOCK_FILE,
  acquireLock,
  localDay,
  lockHeld,
  maybeStartWorker,
  ownsLock,
  readLock,
  readWorkerState,
  releaseLock,
  resumePendingWorker,
  runWorker,
  shouldStartWorker,
  workerLimits,
  writeWorkerState,
} from '../../src/worker/index.js';
import { cli, indexedFixture, rules } from './helpers.js';

const T0 = new Date(2026, 8, 23, 10, 0, 0).getTime();

async function emptyStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'glassbox-worker-'));
  mkdirSync(join(dir, '.glassbox'));
  return dir;
}

describe('worker lock', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await emptyStore();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is exclusive while its process lives', () => {
    expect(acquireLock(dir, T0, { alive: () => true })).toBe(true);
    expect(acquireLock(dir, T0 + 1000, { alive: () => true })).toBe(false);
    expect(readLock(dir)).toMatchObject({ pid: process.pid, startedAt: T0, token: expect.stringMatching(/^[0-9a-f]{24}$/) });
    releaseLock(dir);
    expect(existsSync(join(dir, '.glassbox', WORKER_LOCK_FILE))).toBe(false);
    expect(acquireLock(dir, T0 + 2000)).toBe(true);
  });

  it('takes over a lock whose process died or that is too old', () => {
    expect(acquireLock(dir, T0, { pid: 999_999 })).toBe(true);
    expect(acquireLock(dir, T0 + 1, { alive: () => false })).toBe(true);
    expect(lockHeld(readLock(dir), T0 + 31 * 60_000, undefined, () => true)).toBe(false);
    expect(acquireLock(dir, T0 + 31 * 60_000, { alive: () => true })).toBe(true);
  });

  it('treats an unreadable lock file as held for now, but lets it age out', () => {
    const file = join(dir, '.glassbox', WORKER_LOCK_FILE);
    writeFileSync(file, '{');
    expect(lockHeld(readLock(dir), Date.now())).toBe(true);
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(file, old, old);
    expect(lockHeld(readLock(dir), Date.now())).toBe(false);
    expect(acquireLock(dir)).toBe(true);
    expect(readLock(dir)?.pid).toBe(process.pid);
  });

  it('never lets two workers both take over the same stale lock', () => {
    const file = join(dir, '.glassbox', WORKER_LOCK_FILE);
    writeFileSync(file, JSON.stringify({ pid: 999_999, startedAt: T0 }));
    const fresh = { pid: 424_242, startedAt: T0 + 5 };
    // Worker A reads the stale lock; before A moves it, worker B takes it over and writes its own.
    const alive = (pid: number) => {
      if (pid === 999_999) {
        rmSync(file);
        writeFileSync(file, JSON.stringify(fresh));
      }
      return false;
    };
    expect(acquireLock(dir, T0 + 10, { alive })).toBe(false);
    // B's lock is still in place, and A left nothing behind.
    expect(readLock(dir)).toEqual(fresh);
    expect(readdirSync(join(dir, '.glassbox')).filter((f) => f.includes('.stale'))).toEqual([]);
    expect(acquireLock(dir, T0 + 20, { alive: () => true })).toBe(false);
  });

  it('survives three workers: a late takeover never removes a fresh lock', () => {
    const file = join(dir, '.glassbox', WORKER_LOCK_FILE);
    writeFileSync(file, JSON.stringify({ pid: 999_999, startedAt: T0 }));
    let c = false;
    // B has read the stale lock. While B decides, A takes the lock over properly...
    const aliveB = (pid: number) => {
      if (pid === 999_999) {
        expect(acquireLock(dir, T0 + 1, { alive: () => false, pid: 111 })).toBe(true);
        // ...and C, also starting now, finds A's live lock and backs off.
        c = acquireLock(dir, T0 + 2, { alive: () => true, pid: 222 });
      }
      return false;
    };
    expect(acquireLock(dir, T0 + 3, { alive: aliveB, pid: 333 })).toBe(false);
    expect(c).toBe(false);
    expect(readLock(dir)?.pid).toBe(111);
    expect(readdirSync(join(dir, '.glassbox')).sort()).toEqual([WORKER_LOCK_FILE]);
  });

  it('only releases a lock this process holds', () => {
    const file = join(dir, '.glassbox', WORKER_LOCK_FILE);
    writeFileSync(file, JSON.stringify({ pid: 4242, startedAt: T0, token: 'someone-else' }));
    expect(ownsLock(dir)).toBe(false);
    releaseLock(dir);
    expect(readLock(dir)).toMatchObject({ token: 'someone-else' });
    rmSync(file);
    expect(acquireLock(dir, T0)).toBe(true);
    expect(ownsLock(dir)).toBe(true);
    // Another worker replaced it (it thought this one stale): release leaves that one in place.
    writeFileSync(file, JSON.stringify({ pid: 4243, startedAt: T0 + 1, token: 'newer' }));
    expect(ownsLock(dir)).toBe(false);
    releaseLock(dir);
    expect(readLock(dir)).toMatchObject({ token: 'newer' });
  });

  it('lets one takeover run at a time, and clears a takeover left by a dead process', () => {
    const file = join(dir, '.glassbox', WORKER_LOCK_FILE);
    writeFileSync(file, JSON.stringify({ pid: 999_999, startedAt: T0 }));
    const mutex = `${file}.takeover`;
    writeFileSync(mutex, '');
    expect(acquireLock(dir, T0 + 1, { alive: () => false })).toBe(false);
    expect(readLock(dir)?.pid).toBe(999_999);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(mutex, old, old);
    expect(acquireLock(dir, T0 + 2, { alive: () => false })).toBe(true);
    expect(existsSync(mutex)).toBe(false);
  });
});

describe('worker state and limits', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await emptyStore();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts calls per local day and resets on a new day', () => {
    writeWorkerState(dir, { day: localDay(T0), callsToday: 40, lastStartedAt: T0 });
    expect(readWorkerState(dir, T0 + 1000).callsToday).toBe(40);
    const tomorrow = T0 + 24 * 3600_000;
    expect(readWorkerState(dir, tomorrow)).toMatchObject({ day: localDay(tomorrow), callsToday: 0, lastStartedAt: T0 });
  });

  it('reads limits from env, then config, then defaults', () => {
    expect(workerLimits({})).toMatchObject({ dailyCalls: 100, minIntervalMs: 60_000, maxNodesPerRun: 24 });
    expect(workerLimits({}, { worker: { dailyCalls: 10, minIntervalSec: 30 } })).toMatchObject({ dailyCalls: 10, minIntervalMs: 30_000 });
    expect(workerLimits({ GLASSBOX_WORKER_DAILY_CALLS: '3', GLASSBOX_WORKER_MAX_NODES: '2' }, { worker: { dailyCalls: 10 } })).toMatchObject({
      dailyCalls: 3,
      maxNodesPerRun: 2,
    });
  });

  it('clamps every limit to the hard bounds, from config and env alike', () => {
    const huge = { worker: { dailyCalls: 1e9, minIntervalSec: 0, maxNodesPerRun: 1e9 } };
    expect(workerLimits({}, huge)).toMatchObject({ dailyCalls: 1000, minIntervalMs: 10_000, maxNodesPerRun: 100 });
    expect(workerLimits({ GLASSBOX_WORKER_DAILY_CALLS: '999999', GLASSBOX_WORKER_MIN_INTERVAL_SEC: '0', GLASSBOX_WORKER_MAX_NODES: '5000' })).toMatchObject({
      dailyCalls: 1000,
      minIntervalMs: 10_000,
      maxNodesPerRun: 100,
    });
    const l = workerLimits({});
    expect(l.maxRunMs).toBeLessThan(l.lockMaxAgeMs);
  });
});

describe('starting the worker', () => {
  let root: string;
  beforeEach(async () => {
    root = await indexedFixture();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts once for a burst of edits, then waits out the interval', () => {
    const spawned: string[][] = [];
    const spawner = (_cmd: string, args: readonly string[]) => void spawned.push([...args]);
    const opts = { env: {}, entry: '/x/glassbox.mjs', spawner, host: 'claude-code' };
    expect(maybeStartWorker(root, { ...opts, now: T0 })).toEqual({ start: true });
    expect(maybeStartWorker(root, { ...opts, now: T0 + 5000 })).toEqual({ start: false, reason: 'rate limited' });
    expect(spawned).toEqual([['/x/glassbox.mjs', 'worker', 'run', '--root', root, '--quiet']]);
    expect(maybeStartWorker(root, { ...opts, now: T0 + 61_000 }).start).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it('does not start when nested, disabled, over budget, locked or without a graph', async () => {
    expect(shouldStartWorker(root, { GLASSBOX_NESTED: '1' }, T0)).toMatchObject({ reason: 'nested glassbox call' });
    expect(shouldStartWorker(root, { GLASSBOX_WORKER: '0' }, T0)).toMatchObject({ reason: 'worker disabled' });
    expect(shouldStartWorker(root, {}, T0, { worker: { enabled: false } })).toMatchObject({ reason: 'worker disabled' });
    writeWorkerState(root, { day: localDay(T0), callsToday: 100 });
    expect(shouldStartWorker(root, {}, T0)).toMatchObject({ reason: 'daily call budget used' });
    writeWorkerState(root, { day: localDay(T0), callsToday: 0 });
    acquireLock(root, T0);
    expect(shouldStartWorker(root, {}, T0)).toMatchObject({ reason: 'a worker is running' });
    releaseLock(root);
    const bare = await mkdtemp(join(tmpdir(), 'glassbox-bare-'));
    try {
      expect(shouldStartWorker(bare, {}, T0)).toMatchObject({ reason: 'no glassbox graph' });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('records a put-off start as pending and starts it on a later call once allowed', () => {
    const spawned: string[][] = [];
    const spawner = (_cmd: string, args: readonly string[]) => void spawned.push([...args]);
    const opts = { env: {}, entry: '/x/glassbox.mjs', spawner };
    expect(resumePendingWorker(root, { ...opts, now: T0 })).toEqual({ start: false, reason: 'nothing pending' });
    expect(maybeStartWorker(root, { ...opts, now: T0 }).start).toBe(true);
    expect(readWorkerState(root, T0).pending).toBeUndefined();
    // An edit 5 s later is rate limited: nothing starts, but the re-tag is remembered.
    expect(maybeStartWorker(root, { ...opts, now: T0 + 5000 })).toMatchObject({ reason: 'rate limited' });
    expect(readWorkerState(root, T0 + 5000).pending).toBe(true);
    expect(resumePendingWorker(root, { ...opts, now: T0 + 30_000 })).toMatchObject({ reason: 'rate limited' });
    expect(spawned).toHaveLength(1);
    // No further edit: the next hook call after the interval starts it and clears the flag.
    expect(resumePendingWorker(root, { ...opts, now: T0 + 61_000 })).toEqual({ start: true });
    expect(spawned).toHaveLength(2);
    expect(readWorkerState(root, T0 + 61_000).pending).toBeUndefined();
    expect(resumePendingWorker(root, { ...opts, now: T0 + 200_000 })).toEqual({ start: false, reason: 'nothing pending' });
    expect(resumePendingWorker(root, { ...opts, env: { GLASSBOX_NESTED: '1' }, now: T0 })).toMatchObject({ start: false });
  });

  it('never throws, even when spawning fails', () => {
    const r = maybeStartWorker(root, {
      env: {},
      entry: '/x',
      now: T0,
      spawner: () => {
        throw new Error('no node');
      },
    });
    expect(r).toEqual({ start: false, reason: 'could not start: no node' });
  });
});

describe('runWorker', () => {
  let root: string;
  beforeEach(async () => {
    root = await indexedFixture();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(file: string) {
    await appendFile(join(root, file), '\n// edited\n');
    await refresh(root, { files: [file] });
  }

  it('re-parses and re-tags stale nodes in fast mode, counting model runs', async () => {
    await touch('src/billing/retry.ts');
    const backend = new FakeBackend({ rules });
    const r = await runWorker(root, { env: {}, backend: () => backend, now: () => T0 });
    expect(r.ran).toBe(true);
    expect(r.summary!.asked).toBeGreaterThan(0);
    expect(r.summary!.failed).toBe(0);
    // One option order per group: every call is a single permutation.
    expect(backend.calls.length).toBe(r.summary!.modelRuns);
    expect(r.state).toMatchObject({ callsToday: r.summary!.modelRuns, lastStartedAt: T0, lastFinishedAt: T0 });
    expect(existsSync(join(root, '.glassbox', WORKER_LOCK_FILE))).toBe(false);
    const again = await runWorker(root, { env: {}, backend: () => backend, now: () => T0 + 120_000 });
    expect(again).toMatchObject({ ran: false, reason: 'nothing stale' });
  });

  it('stops at the daily budget and at maxNodesPerRun', async () => {
    await touch('src/billing/retry.ts');
    await touch('src/auth/session.ts');
    writeWorkerState(root, { day: localDay(T0), callsToday: 98 });
    const backend = new FakeBackend({ rules });
    const r = await runWorker(root, { env: { GLASSBOX_WORKER_MAX_NODES: '5' }, backend: () => backend, now: () => T0 });
    expect(r.ran).toBe(true);
    expect(r.summary!.asked).toBeLessThanOrEqual(2);
    expect(r.summary!.deferred).toBeGreaterThan(0);
    expect(r.state.callsToday).toBeLessThanOrEqual(100);
    writeWorkerState(root, { ...r.state, callsToday: 100 });
    const calls = backend.calls.length;
    const over = await runWorker(root, { env: {}, backend: () => backend, now: () => T0 + 120_000 });
    expect(over).toMatchObject({ ran: false, reason: 'daily call budget used' });
    expect(backend.calls.length).toBe(calls);
  });

  it('respects the minimum interval unless forced, and never runs twice at once', async () => {
    await touch('src/billing/retry.ts');
    writeWorkerState(root, { day: localDay(T0), callsToday: 0, lastStartedAt: T0 });
    const backend = () => new FakeBackend({ rules });
    expect(await runWorker(root, { env: {}, backend, now: () => T0 + 1000 })).toMatchObject({ ran: false, reason: 'rate limited' });
    acquireLock(root, T0 + 1000);
    expect(await runWorker(root, { env: {}, backend, now: () => T0 + 2000, ignoreInterval: true })).toMatchObject({
      ran: false,
      reason: 'a worker is running',
    });
    releaseLock(root);
    expect((await runWorker(root, { env: {}, backend, now: () => T0 + 2000, ignoreInterval: true })).ran).toBe(true);
  });

  it('records a backend failure and counts the failed calls', async () => {
    await touch('src/billing/retry.ts');
    const backend = new FakeBackend({ rules, failCalls: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const r = await runWorker(root, { env: {}, backend: () => backend, now: () => T0 });
    expect(r.summary!.failed).toBeGreaterThan(0);
    expect(r.state.lastError).toMatch(/fake failure/);
    expect(r.state.callsToday).toBe(backend.calls.length);
  });

  it('charges the worst case before the first model call and settles to the real count', async () => {
    await touch('src/billing/retry.ts');
    writeWorkerState(root, { day: localDay(T0), callsToday: 10 });
    const inner = new FakeBackend({ rules });
    let seen: number | undefined;
    const spy: Backend = {
      name: 'spy',
      capabilities: inner.capabilities,
      answerBatch: (state, questions) => {
        seen ??= readWorkerState(root, T0).callsToday;
        return inner.answerBatch(state, questions);
      },
    };
    const r = await runWorker(root, { env: { GLASSBOX_WORKER_MAX_NODES: '6' }, backend: () => spy, now: () => T0 });
    expect(r.ran).toBe(true);
    // While the calls ran, the budget already held the worst case (one call per node), so a
    // worker killed at this point would still have counted them.
    expect(seen).toBeGreaterThanOrEqual(10 + r.summary!.asked);
    expect(r.state.callsToday).toBe(10 + r.summary!.modelRuns);
    expect(readWorkerState(root, T0).callsToday).toBe(10 + r.summary!.modelRuns);
  });

  it('charges one backend call per question and node for a backend that does not batch', async () => {
    await touch('src/billing/retry.ts');
    writeWorkerState(root, { day: localDay(T0), callsToday: 0 });
    const inner = new FakeBackend({ rules });
    let seen: number | undefined;
    let calls = 0;
    const single: Backend = {
      name: 'single',
      capabilities: { ...inner.capabilities, batch: false },
      answerBatch: (state, questions) => {
        seen ??= readWorkerState(root, T0).callsToday;
        calls++;
        return inner.answerBatch(state, questions);
      },
    };
    const r = await runWorker(root, { env: { GLASSBOX_WORKER_MAX_NODES: '2' }, backend: () => single, now: () => T0 });
    expect(r.ran).toBe(true);
    const questionsPerNode = calls / r.summary!.asked;
    expect(questionsPerNode).toBeGreaterThan(1);
    // The up-front charge covered every call the run made, and the settled count is the real one.
    expect(seen).toBeGreaterThanOrEqual(calls);
    expect(r.summary!.modelRuns).toBe(calls);
    expect(r.state.callsToday).toBe(calls);
  });

  it('never starts more backend calls than the budget has left when the backend does not batch', async () => {
    await touch('src/billing/retry.ts');
    const inner = new FakeBackend({ rules });
    let calls = 0;
    const single: Backend = {
      name: 'single',
      capabilities: { ...inner.capabilities, batch: false },
      answerBatch: (state, questions) => {
        calls++;
        return inner.answerBatch(state, questions);
      },
    };
    writeWorkerState(root, { day: localDay(T0), callsToday: 100 - 3 });
    // 3 runs left, fewer than one node's questions: nothing is asked.
    const r = await runWorker(root, { env: {}, backend: () => single, now: () => T0 });
    expect(r).toMatchObject({ ran: false, reason: 'daily call budget used' });
    expect(calls).toBe(0);
  });

  it('knows the Anthropic SDK retries: worst case per call, counted only for its own client', () => {
    const own = new AnthropicBackend({ env: {}, apiKey: 'k' });
    expect(own.maxRequestsPerCall).toBe(4);
    expect(own.requestCount).toBe(0);
    const injected = new AnthropicBackend({ env: {}, client: { messages: { create: async () => ({ content: [] }) } } as never });
    expect(injected.requestCount).toBeUndefined();
  });

  it('charges every HTTP request, retries included, against the daily budget', async () => {
    await touch('src/billing/retry.ts');
    await touch('src/auth/session.ts');
    let requests = 0;
    const failing = new OpenAICompatBackend({
      model: 'm',
      apiKey: 'k',
      env: {},
      sleep: async () => {},
      fetch: (async () => {
        requests++;
        return new Response('down', { status: 500 });
      }) as typeof fetch,
    });
    expect(failing.maxRequestsPerCall).toBe(4);
    for (const daily of [10, 60]) {
      writeWorkerState(root, { day: localDay(T0), callsToday: 0 });
      requests = 0;
      const r = await runWorker(root, { env: { GLASSBOX_WORKER_DAILY_CALLS: String(daily) }, backend: () => failing, now: () => T0 });
      // Every 500 is retried 3 times, and every attempt counts: never more requests than the budget.
      expect(requests).toBeLessThanOrEqual(daily);
      expect(readWorkerState(root, T0).callsToday).toBe(requests);
      if (daily === 60) {
        expect(requests).toBeGreaterThan(0);
        expect(r.summary!.modelRuns).toBe(requests);
      }
    }
  });

  it('stops its model calls at the time cap and leaves the rest pending', async () => {
    await touch('src/billing/retry.ts');
    const hang: Backend = {
      name: 'hang',
      capabilities: { hasLogprobs: false, batch: true },
      // Like the CLI backends: a call made after the abort fails at once, a running one when it comes.
      answerBatch: (_state, _q, opts) =>
        new Promise((_ok, fail) => {
          if (opts?.signal?.aborted) return fail(opts.signal.reason as Error);
          opts?.signal?.addEventListener('abort', () => fail(opts.signal!.reason as Error), { once: true });
        }),
    };
    const started = Date.now();
    const r = await runWorker(root, { env: {}, backend: () => hang, now: () => T0, maxRunMs: 50 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ran).toBe(true);
    expect(r.state.lastError).toMatch(/time cap/);
    expect(r.state.pending).toBe(true);
    expect(existsSync(join(root, '.glassbox', WORKER_LOCK_FILE))).toBe(false);
  });

  it('marks nodes left over by the node limit as pending', async () => {
    await touch('src/billing/retry.ts');
    await touch('src/auth/session.ts');
    const r = await runWorker(root, { env: { GLASSBOX_WORKER_MAX_NODES: '1' }, backend: () => new FakeBackend({ rules }), now: () => T0 });
    expect(r.summary!.deferred).toBeGreaterThan(0);
    expect(r.state.pending).toBe(true);
    const s = await cli(root, ['status'], { now: () => T0 });
    expect(s.out).toContain('re-tag pending');
  });

  it('glassbox worker run and glassbox status', async () => {
    await touch('src/billing/retry.ts');
    const now = () => T0;
    const w = await cli(root, ['worker', 'run'], { now });
    expect(w.code).toBe(0);
    expect(w.out).toMatch(/^worker {2}\d+ nodes asked, \d+ tags, \d+ model runs, 0 failed; today \d+ model runs/);
    const s = await cli(root, ['status'], { now });
    expect(s.out).toMatch(/^graph {4}17 files, \d+ nodes, \d+ edges, 0 stale; (\d+)\/\1 tag targets tagged; parsed /);
    expect(s.out).toContain('mode     balanced (default)');
    expect(s.out).toContain('hooks    ambient off, gate off, concise rules off, worker on');
    expect(s.out).toMatch(/worker {3}idle; today \d+\/100 model runs; next run allowed/);
    expect(s.out).toMatch(/last run .*: \d+ nodes asked/);
    const j = JSON.parse((await cli(root, ['status', '--json'], { now })).out) as { worker: { budgetLeft: number } };
    expect(j.worker.budgetLeft).toBeLessThan(100);
  });
});

describe('status without a graph', () => {
  it('says so and reads nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-status-'));
    try {
      const s = await status(dir, { GLASSBOX_MODE: 'fast', GLASSBOX_AMBIENT: '1' });
      expect(s.graph).toBeUndefined();
      const text = renderStatus(s);
      expect(text).toContain('graph    none (run `glassbox init`)');
      expect(text).toContain('mode     fast (from env)');
      expect(text).toContain('ambient on');
      expect(existsSync(join(dir, '.glassbox'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
