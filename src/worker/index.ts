import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectConfigSafe, featureEnabled, type ProjectConfig } from '../project-config.js';
import type { Backend } from '../types.js';
import { assertNotSymlinkSync } from '../util/safefs.js';

// Same directory and file as the graph store; kept local so hooks can check them without loading node:sqlite.
const STORE_DIR = '.glassbox';
const STORE_FILE = 'graph.db';
export const WORKER_STATE_FILE = 'worker.json';
export const WORKER_LOCK_FILE = 'worker.lock';

export interface WorkerLimits {
  /** Most model runs per local calendar day. */
  dailyCalls: number;
  /** Fewest ms between two worker starts. */
  minIntervalMs: number;
  /** Most nodes re-tagged per run. */
  maxNodesPerRun: number;
  /** A lock older than this is taken over even if its process looks alive (its pid was likely reused). */
  lockMaxAgeMs: number;
  /** Longest one run may take; it stops its model calls and exits then. Kept below lockMaxAgeMs. */
  maxRunMs: number;
}

export const DEFAULT_WORKER_LIMITS: Readonly<WorkerLimits> = Object.freeze({
  dailyCalls: 100,
  minIntervalMs: 60_000,
  maxNodesPerRun: 24,
  lockMaxAgeMs: 30 * 60_000,
  maxRunMs: 20 * 60_000,
});

/**
 * Bounds no setting can pass, from the environment or .glassbox/config.json:
 * at most 1000 model runs a day, at least 10 s between runs, at most 100
 * nodes per run.
 */
export const WORKER_HARD_LIMITS = Object.freeze({ maxDailyCalls: 1000, minIntervalMs: 10_000, maxNodesPerRun: 100 });

export interface WorkerRunSummary {
  asked: number;
  tags: number;
  deferred: number;
  failed: number;
  /** Model runs spent (backend calls times samples per call). */
  modelRuns: number;
  latencyMs: number;
}

export interface WorkerState {
  /** Local date (YYYY-MM-DD) that callsToday counts. */
  day: string;
  /** Model runs spent today. */
  callsToday: number;
  lastSpawnAt?: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastResult?: WorkerRunSummary;
  lastError?: string;
  /** Why the last run did no work, if it did none. */
  lastSkip?: string;
  /**
   * Stale nodes are waiting for a run that could not start yet (rate limited,
   * a worker already running, or no budget left). The next hook call starts
   * the worker once it is allowed.
   */
  pending?: boolean;
}

export interface WorkerLock {
  pid: number;
  startedAt: number;
}

function int(v: string | undefined): number | undefined {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * Limits from GLASSBOX_WORKER_* variables, then .glassbox/config.json `worker`,
 * then the defaults, each clamped to WORKER_HARD_LIMITS.
 */
export function workerLimits(env: NodeJS.ProcessEnv, config: ProjectConfig = {}): WorkerLimits {
  const w = config.worker ?? {};
  const floor = (v: number | undefined) => (v !== undefined ? Math.floor(v) : undefined);
  const intervalSec = int(env.GLASSBOX_WORKER_MIN_INTERVAL_SEC) ?? w.minIntervalSec;
  const daily = int(env.GLASSBOX_WORKER_DAILY_CALLS) ?? floor(w.dailyCalls) ?? DEFAULT_WORKER_LIMITS.dailyCalls;
  const nodes = int(env.GLASSBOX_WORKER_MAX_NODES) ?? floor(w.maxNodesPerRun) ?? DEFAULT_WORKER_LIMITS.maxNodesPerRun;
  const interval = intervalSec !== undefined ? intervalSec * 1000 : DEFAULT_WORKER_LIMITS.minIntervalMs;
  return {
    dailyCalls: Math.min(daily, WORKER_HARD_LIMITS.maxDailyCalls),
    minIntervalMs: Math.max(interval, WORKER_HARD_LIMITS.minIntervalMs),
    maxNodesPerRun: Math.min(nodes, WORKER_HARD_LIMITS.maxNodesPerRun),
    lockMaxAgeMs: DEFAULT_WORKER_LIMITS.lockMaxAgeMs,
    maxRunMs: DEFAULT_WORKER_LIMITS.maxRunMs,
  };
}

/** Whether hooks and the launcher may start the worker: GLASSBOX_WORKER, config `worker.enabled`, plugin option, default on. */
export function workerEnabled(env: NodeJS.ProcessEnv, config: ProjectConfig = {}): boolean {
  return featureEnabled(env, { env: 'GLASSBOX_WORKER', plugin: 'CLAUDE_PLUGIN_OPTION_WORKER' }, config.worker?.enabled, true);
}

export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function storeFile(root: string, name: string): string {
  const dir = join(root, STORE_DIR);
  assertNotSymlinkSync(dir);
  const file = join(dir, name);
  assertNotSymlinkSync(file);
  return file;
}

/** The worker state; a new day starts with zero calls. Unreadable state counts as empty. */
export function readWorkerState(root: string, now = Date.now()): WorkerState {
  const day = localDay(now);
  let raw: Partial<WorkerState> = {};
  try {
    raw = JSON.parse(readFileSync(storeFile(root, WORKER_STATE_FILE), 'utf8')) as Partial<WorkerState>;
  } catch {
    raw = {};
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const state: WorkerState = { day, callsToday: raw.day === day ? (num(raw.callsToday) ?? 0) : 0 };
  for (const k of ['lastSpawnAt', 'lastStartedAt', 'lastFinishedAt'] as const) {
    const v = num(raw[k]);
    if (v !== undefined) state[k] = v;
  }
  if (raw.lastResult && typeof raw.lastResult === 'object') state.lastResult = raw.lastResult;
  if (typeof raw.lastError === 'string') state.lastError = raw.lastError.slice(0, 500);
  if (typeof raw.lastSkip === 'string') state.lastSkip = raw.lastSkip.slice(0, 200);
  if (raw.pending === true) state.pending = true;
  return state;
}

/** Writes the state atomically (temp file plus rename, never through a symlink). */
export function writeWorkerState(root: string, state: WorkerState): void {
  const file = storeFile(root, WORKER_STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'wx', 0o644);
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** True when a process with this pid exists (EPERM means it exists but is not ours). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockAt(file: string): WorkerLock | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const v = JSON.parse(text) as Partial<WorkerLock>;
    if (typeof v.pid === 'number' && typeof v.startedAt === 'number') return { pid: v.pid, startedAt: v.startedAt };
  } catch {
    // Handled below.
  }
  // A lock file that exists but does not parse is still a lock (maybe being written),
  // as old as the file itself, so a broken one ages out instead of blocking forever.
  let mtime = Date.now();
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    // Gone between the read and the stat; the caller's next step sees that.
  }
  return { pid: -1, startedAt: Math.floor(mtime) };
}

export function readLock(root: string): WorkerLock | undefined {
  try {
    return readLockAt(storeFile(root, WORKER_LOCK_FILE));
  } catch {
    return { pid: -1, startedAt: Date.now() };
  }
}

function sameLock(a: WorkerLock | undefined, b: WorkerLock): boolean {
  return a !== undefined && a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Moves a stale lock out of the way without a window where two workers both
 * think they took it over: the lock is renamed to a name only this process
 * uses, then checked. When what was moved is not the stale lock read before
 * (another worker replaced it in between), it is put back with link(), which
 * never overwrites a lock that appeared since, and the takeover fails.
 * True when the lock file is now gone and this process may try to create one.
 */
function takeOverStaleLock(file: string, stale: WorkerLock): boolean {
  const aside = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
  try {
    renameSync(file, aside);
  } catch (err) {
    // Someone else already moved it: the O_EXCL create decides who gets the new lock.
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  let moved: WorkerLock | undefined;
  try {
    moved = readLockAt(aside);
  } catch {
    moved = undefined;
  }
  if (sameLock(moved, stale)) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, file);
  } catch {
    // A newer lock is already in place; it wins.
  }
  rmSync(aside, { force: true });
  return false;
}

/** A lock holds while its process is alive and it is younger than lockMaxAgeMs. */
export function lockHeld(
  lock: WorkerLock | undefined,
  now: number,
  maxAgeMs = DEFAULT_WORKER_LIMITS.lockMaxAgeMs,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  if (!lock) return false;
  if (now - lock.startedAt > maxAgeMs) return false;
  return lock.pid === -1 || alive(lock.pid);
}

/**
 * Takes the worker lock (created with O_EXCL, so two workers never both get
 * it). A lock left by a dead process, or older than maxAgeMs, is taken over
 * first with takeOverStaleLock, so two workers that both saw the same stale
 * lock cannot both end up running.
 */
export function acquireLock(
  root: string,
  now = Date.now(),
  opts: { maxAgeMs?: number; alive?: (pid: number) => boolean; pid?: number } = {},
): boolean {
  const file = storeFile(root, WORKER_LOCK_FILE);
  const existing = readLock(root);
  if (existing) {
    if (lockHeld(existing, now, opts.maxAgeMs, opts.alive)) return false;
    if (!takeOverStaleLock(file, existing)) return false;
  }
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: opts.pid ?? process.pid, startedAt: now }));
  } finally {
    closeSync(fd);
  }
  return true;
}

export function releaseLock(root: string): void {
  try {
    rmSync(storeFile(root, WORKER_LOCK_FILE), { force: true });
  } catch {
    // A symlinked lock is left alone.
  }
}

export type StartDecision = { start: true } | { start: false; reason: string };

/** Cheap checks (no sqlite, no model) on whether a worker should start now. */
export function shouldStartWorker(root: string, env: NodeJS.ProcessEnv, now = Date.now(), config?: ProjectConfig): StartDecision {
  if (env.GLASSBOX_NESTED === '1') return { start: false, reason: 'nested glassbox call' };
  if (!existsSync(join(root, STORE_DIR, STORE_FILE))) return { start: false, reason: 'no glassbox graph' };
  const cfg = config ?? loadProjectConfigSafe(root);
  if (!workerEnabled(env, cfg)) return { start: false, reason: 'worker disabled' };
  const limits = workerLimits(env, cfg);
  if (lockHeld(readLock(root), now, limits.lockMaxAgeMs)) return { start: false, reason: 'a worker is running' };
  const state = readWorkerState(root, now);
  if (state.callsToday >= limits.dailyCalls) return { start: false, reason: 'daily call budget used' };
  const last = Math.max(state.lastSpawnAt ?? 0, state.lastStartedAt ?? 0);
  if (now - last < limits.minIntervalMs) return { start: false, reason: 'rate limited' };
  return { start: true };
}

/** Starts a process that outlives the caller and is not waited for. Injectable for tests. */
export type DetachedSpawner = (cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => void;

export const spawnDetached: DetachedSpawner = (cmd, args, opts) => {
  const child = spawn(cmd, [...args], { cwd: opts.cwd, env: opts.env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
};

/** Reasons a start was refused that go away with time, so the stale nodes are marked pending. */
const DEFERRED_REASONS = new Set(['rate limited', 'a worker is running', 'daily call budget used']);

export interface StartOptions {
  env: NodeJS.ProcessEnv;
  entry: string;
  spawner?: DetachedSpawner;
  now?: number;
  host?: string;
}

/**
 * Starts `node <entry> worker run --root <root>` detached when the checks
 * pass, and records the spawn time so a burst of edits starts one worker.
 * When the start is only put off (rate limited, a worker running, no budget
 * left today), it records `pending` so a later hook call starts the worker.
 * Never throws: a hook must not fail because the worker could not start.
 */
export function maybeStartWorker(root: string, opts: StartOptions): StartDecision {
  try {
    const now = opts.now ?? Date.now();
    const decision = shouldStartWorker(root, opts.env, now);
    if (!decision.start) {
      if (DEFERRED_REASONS.has(decision.reason)) {
        const state = readWorkerState(root, now);
        if (!state.pending) writeWorkerState(root, { ...state, pending: true });
      }
      return decision;
    }
    const state = readWorkerState(root, now);
    delete state.pending;
    writeWorkerState(root, { ...state, lastSpawnAt: now });
    const env: NodeJS.ProcessEnv = { ...opts.env };
    if (opts.host) env.GLASSBOX_HOST = opts.host;
    (opts.spawner ?? spawnDetached)(process.execPath, [opts.entry, 'worker', 'run', '--root', root, '--quiet'], { cwd: root, env });
    return decision;
  } catch (err) {
    return { start: false, reason: `could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Starts the worker when an earlier start was put off (`pending` in
 * worker.json) and it is now allowed. Cheap when nothing is pending: one small
 * JSON read. Never throws.
 */
export function resumePendingWorker(root: string, opts: StartOptions): StartDecision {
  try {
    if (opts.env.GLASSBOX_NESTED === '1') return { start: false, reason: 'nested glassbox call' };
    if (!existsSync(join(root, STORE_DIR, WORKER_STATE_FILE))) return { start: false, reason: 'nothing pending' };
    if (!readWorkerState(root, opts.now ?? Date.now()).pending) return { start: false, reason: 'nothing pending' };
    return maybeStartWorker(root, opts);
  } catch (err) {
    return { start: false, reason: `could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** True when worker.json says a re-tag run is waiting. */
export function workerPending(root: string, now = Date.now()): boolean {
  return existsSync(join(root, STORE_DIR, WORKER_STATE_FILE)) && readWorkerState(root, now).pending === true;
}

export interface WorkerRunOptions {
  /** Built only when there is work to do and budget left. Should be a fast-mode backend (1 sample). */
  backend: () => Backend;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  /** Skip the minimum-interval check (an explicit `glassbox worker run`). The budget still applies. */
  ignoreInterval?: boolean;
  /** Overrides limits.maxRunMs (tests). */
  maxRunMs?: number;
}

export interface WorkerRunResult {
  ran: boolean;
  /** Why nothing ran. */
  reason?: string;
  summary?: WorkerRunSummary;
  state: WorkerState;
}

/**
 * One worker run: take the lock, re-parse changed files (no model calls),
 * then re-tag stale nodes in fast mode, at most maxNodesPerRun and never past
 * the daily budget. The worst case of the run is charged to the budget before
 * any model call and settled to the real count afterwards, so a run that is
 * killed half way still counts. The run stops its model calls after
 * maxRunMs. Nodes left stale (the node limit, the budget or the time cap)
 * are marked pending for a later run.
 */
export async function runWorker(root: string, opts: WorkerRunOptions): Promise<WorkerRunResult> {
  const now = opts.now ?? Date.now;
  const config = loadProjectConfigSafe(root);
  const limits = workerLimits(opts.env, config);
  if (!existsSync(join(root, STORE_DIR, STORE_FILE))) return { ran: false, reason: 'no glassbox graph', state: readWorkerState(root, now()) };
  if (!acquireLock(root, now(), { maxAgeMs: limits.lockMaxAgeMs })) {
    return { ran: false, reason: 'a worker is running', state: readWorkerState(root, now()) };
  }
  let state = readWorkerState(root, now());
  const skip = (reason: string, pending?: boolean): WorkerRunResult => {
    state = { ...readWorkerState(root, now()), lastSkip: reason };
    if (pending === true) state.pending = true;
    else if (pending === false) delete state.pending;
    writeWorkerState(root, state);
    return { ran: false, reason, state };
  };
  const maxRunMs = Math.min(opts.maxRunMs ?? limits.maxRunMs, limits.lockMaxAgeMs - 60_000);
  const abort = new AbortController();
  const cap = setTimeout(() => abort.abort(new Error(`worker stopped at its ${Math.round(maxRunMs / 1000)} s time cap`)), Math.max(0, maxRunMs));
  let charged = 0;
  try {
    if (state.callsToday >= limits.dailyCalls) return skip('daily call budget used', true);
    if (!opts.ignoreInterval && state.lastStartedAt !== undefined && now() - state.lastStartedAt < limits.minIntervalMs) {
      return skip('rate limited', true);
    }
    const startedAt = now();
    state = { ...state, lastStartedAt: startedAt };
    delete state.lastSkip;
    // Edits from here on set it again, so the run after this one picks them up.
    delete state.pending;
    writeWorkerState(root, state);

    const [{ GraphStore }, { indexRepo }, { tagPass, isTagTarget, tagsFresh, defaultTagQuestions, inferAreas }] = await Promise.all([
      import('../memory/store.js'),
      import('../memory/source.js'),
      import('../memory/tags.js'),
    ]);
    const store = GraphStore.open(root);
    try {
      await indexRepo(root, store);
      const all = store.getNodes();
      const qids = Object.keys(defaultTagQuestions(inferAreas(all.map((n) => n.file))));
      const todo = all.filter((n) => isTagTarget(n) && !tagsFresh(store, n, qids)).length;
      if (todo === 0) return skip('nothing stale');
      const backend = opts.backend();
      const runsPerCall = Math.max(1, backend.samples ?? 1);
      // Worst case one node per call, so the node limit alone keeps the run inside the budget.
      const affordable = Math.floor((limits.dailyCalls - state.callsToday) / runsPerCall);
      const limit = Math.min(limits.maxNodesPerRun, affordable, todo);
      if (limit <= 0) return skip('daily call budget used', true);
      // Charge the worst case up front; settled below. A killed run keeps the charge.
      charged = limit * runsPerCall;
      state = readWorkerState(root, now());
      state.callsToday += charged;
      writeWorkerState(root, state);

      const r = await tagPass(root, backend, { store, limit, concurrency: 2, decide: { permutations: 1, signal: abort.signal } });
      const calls = r.calls + r.failed.length;
      const summary: WorkerRunSummary = {
        asked: r.asked,
        tags: r.tags,
        deferred: r.deferred,
        failed: r.failed.length,
        modelRuns: calls * runsPerCall,
        latencyMs: r.latencyMs,
      };
      state = { ...readWorkerState(root, now()), lastFinishedAt: now(), lastResult: summary };
      state.callsToday = Math.max(0, state.callsToday - charged) + summary.modelRuns;
      charged = 0;
      if (state.lastStartedAt === undefined) state.lastStartedAt = startedAt;
      if (abort.signal.aborted) state.lastError = String((abort.signal.reason as Error | undefined)?.message ?? 'worker stopped at its time cap');
      else if (r.failed.length) state.lastError = r.failed[0]!.error.slice(0, 500);
      else delete state.lastError;
      if (r.deferred > 0 || r.failed.length > 0) state.pending = true;
      writeWorkerState(root, state);
      return { ran: true, summary, state };
    } finally {
      store.close();
    }
  } catch (err) {
    const fresh = (() => {
      try {
        return readWorkerState(root, now());
      } catch {
        return state;
      }
    })();
    state = { ...fresh, lastFinishedAt: now(), lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500), pending: true };
    try {
      writeWorkerState(root, state);
    } catch {
      // Nothing more to do.
    }
    return { ran: false, reason: state.lastError!, state };
  } finally {
    clearTimeout(cap);
    releaseLock(root);
  }
}
