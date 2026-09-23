import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backends/fake.js';
import { refresh } from '../../src/memory/refresh.js';
import { renderStatus, status } from '../../src/status.js';
import {
  WORKER_LOCK_FILE,
  acquireLock,
  localDay,
  lockHeld,
  maybeStartWorker,
  readLock,
  readWorkerState,
  releaseLock,
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
    expect(readLock(dir)).toEqual({ pid: process.pid, startedAt: T0 });
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

  it('treats an unreadable lock file as held for now', () => {
    writeFileSync(join(dir, '.glassbox', WORKER_LOCK_FILE), '{');
    expect(lockHeld(readLock(dir), Date.now())).toBe(true);
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
    expect(workerLimits({}, { worker: { dailyCalls: 10, minIntervalSec: 5 } })).toMatchObject({ dailyCalls: 10, minIntervalMs: 5000 });
    expect(workerLimits({ GLASSBOX_WORKER_DAILY_CALLS: '3', GLASSBOX_WORKER_MAX_NODES: '2' }, { worker: { dailyCalls: 10 } })).toMatchObject({
      dailyCalls: 3,
      maxNodesPerRun: 2,
    });
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

  it('glassbox worker run and glassbox status', async () => {
    await touch('src/billing/retry.ts');
    const now = () => T0;
    const w = await cli(root, ['worker', 'run'], { now });
    expect(w.code).toBe(0);
    expect(w.out).toMatch(/^worker {2}\d+ nodes asked, \d+ tags, \d+ model runs, 0 failed; today \d+ model runs/);
    const s = await cli(root, ['status'], { now });
    expect(s.out).toMatch(/^graph {4}17 files, \d+ nodes, \d+ edges, 0 stale; (\d+)\/\1 tag targets tagged; parsed /);
    expect(s.out).toContain('mode     balanced (default)');
    expect(s.out).toContain('hooks    ambient off, gate off, worker on');
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
