import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { ALWAYS_SKIP } from '../graph/walk.js';
import { grammarFor } from '../graph/languages.js';
import { editHooksEnabled, envFlag, featureEnabled, loadProjectConfigSafe, type ProjectConfig } from '../project-config.js';
import { assertNotSymlinkSync, ensureStoreDirSync } from '../util/safefs.js';
import { storeTrackedByGit } from '../util/tracked.js';
import {
  acquireLock,
  handOverLock,
  lockHeld,
  maybeStartWorker,
  readLock,
  releaseLock,
  releaseLockOfPid,
  spawnDetached,
  workerEnabled,
  type DetachedSpawner,
  type StartDecision,
} from '../worker/index.js';

/**
 * Auto-init: the session-start hook builds the code graph by itself in a git
 * repo that has none, so nobody has to run `glassbox init` by hand. The hook
 * only checks cheap conditions, takes a lock and starts a detached
 * `glassbox init --structure-only --auto`, which parses the code and writes
 * .glassbox/ (graph plus its .gitignore) with no model calls and no AGENTS.md
 * or CLAUDE.md writes. Tags come later from the budgeted background worker,
 * and only when the edit hooks are on.
 */

// Same directory and file as the graph store; kept local so the hook never loads node:sqlite to check them.
const STORE_DIR = '.glassbox';
const STORE_FILE = 'graph.db';
export const AUTOINIT_LOCK_FILE = 'autoinit.lock';
export const AUTOINIT_STATE_FILE = 'autoinit.json';
export const DEFAULT_AUTO_INIT_MAX_FILES = 5000;
/** A lock older than this is taken over even if its process looks alive. */
export const AUTOINIT_LOCK_MAX_AGE_MS = 15 * 60_000;
/** After a failed or skipped auto-init, sessions wait this long before trying again. */
export const AUTOINIT_RETRY_MS = 24 * 60 * 60_000;
/** Longest the file count may take in the hook; slower means the repo is treated as too big. */
const COUNT_TIMEOUT_MS = 1000;

export const INDEXING_CONTEXT =
  'glassbox is indexing this repository in the background (code graph only, no model calls). ' +
  'Its code map is added from the next session on; the glassbox MCP tools already work.';

export interface AutoInitState {
  startedAt?: number;
  finishedAt?: number;
  /** The graph was built without tags and no full `glassbox init` has run since. */
  structureOnly?: boolean;
  /** True when the session-start hook started it (not a manual `init --structure-only`). */
  auto?: boolean;
  files?: number;
  nodes?: number;
  error?: string;
  skipped?: string;
  /** Epoch ms of the last full `glassbox init`. */
  fullInitAt?: number;
}

/** Auto-init switch: GLASSBOX_AUTO_INIT, then .glassbox/config.json `autoInit` (only false when git tracks it), then the plugin's auto_init option, default on. */
export function autoInitEnabled(env: NodeJS.ProcessEnv, config: ProjectConfig = {}): boolean {
  return featureEnabled(env, { env: 'GLASSBOX_AUTO_INIT', plugin: 'CLAUDE_PLUGIN_OPTION_AUTO_INIT' }, config.autoInit, true);
}

/** GLASSBOX_AUTO_INIT_MAX_FILES, default 5000. */
export function autoInitMaxFiles(env: NodeJS.ProcessEnv): number {
  const n = Number(env.GLASSBOX_AUTO_INIT_MAX_FILES);
  return env.GLASSBOX_AUTO_INIT_MAX_FILES?.trim() && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_AUTO_INIT_MAX_FILES;
}

function storeFile(root: string, name: string): string {
  const dir = join(root, STORE_DIR);
  assertNotSymlinkSync(dir);
  const file = join(dir, name);
  assertNotSymlinkSync(file);
  return file;
}

export function readAutoInitState(root: string): AutoInitState | undefined {
  try {
    const v = JSON.parse(readFileSync(storeFile(root, AUTOINIT_STATE_FILE), 'utf8')) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    const out: AutoInitState = {};
    for (const k of ['startedAt', 'finishedAt', 'files', 'nodes', 'fullInitAt'] as const) {
      if (typeof o[k] === 'number' && Number.isFinite(o[k])) out[k] = o[k];
    }
    for (const k of ['structureOnly', 'auto'] as const) if (typeof o[k] === 'boolean') out[k] = o[k];
    for (const k of ['error', 'skipped'] as const) if (typeof o[k] === 'string') out[k] = o[k].slice(0, 300);
    return out;
  } catch {
    return undefined;
  }
}

/** Writes the state atomically (temp file plus rename, never through a symlink). */
export function writeAutoInitState(root: string, state: AutoInitState): void {
  const file = storeFile(root, AUTOINIT_STATE_FILE);
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

/** True while an auto-init run holds its lock. */
export function autoInitRunning(root: string, now = Date.now()): { since: number } | undefined {
  if (!existsSync(join(root, STORE_DIR, AUTOINIT_LOCK_FILE))) return undefined;
  const lock = readLock(root, AUTOINIT_LOCK_FILE);
  return lock && lockHeld(lock, now, AUTOINIT_LOCK_MAX_AGE_MS) ? { since: lock.startedAt } : undefined;
}

/** True when the graph was built structure-only and no full init has run since. */
export function isStructureOnly(root: string): boolean {
  return readAutoInitState(root)?.structureOnly === true;
}

function git(cwd: string, args: string[], timeout: number): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** The top of the git work tree that holds `start`, or undefined outside one. */
export function gitWorkTreeRoot(start: string): string | undefined {
  if (!existsSync(start)) return undefined;
  // Fails outside a work tree (and inside .git or a bare repo).
  const top = git(start, ['rev-parse', '--show-toplevel'], 2000)?.trim();
  return top ? resolve(top) : undefined;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The home directory or a file system root: never indexed automatically. */
export function forbiddenRoot(root: string, env: NodeJS.ProcessEnv): boolean {
  const r = real(root);
  if (parse(r).root === r) return true;
  const homes = [homedir(), env.HOME, env.USERPROFILE].filter((h): h is string => !!h?.trim());
  return homes.some((h) => real(h) === r);
}

/** True for a path the graph would parse: a supported extension, outside the always-skipped directories. */
export function isSourcePath(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => ALWAYS_SKIP.has(p))) return false;
  return grammarFor(parts[parts.length - 1] ?? '') !== null;
}

/**
 * Supported source files git would show (tracked, plus untracked files that
 * .gitignore does not exclude). Undefined when git fails or is too slow.
 */
export function countSourceFiles(root: string, timeout = COUNT_TIMEOUT_MS): number | undefined {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], timeout);
  if (out === undefined) return undefined;
  const seen = new Set<string>();
  for (const f of out.split('\0')) if (f && isSourcePath(f)) seen.add(f);
  return seen.size;
}

export type AutoInitCheck =
  | { action: 'init'; root: string; files: number }
  | { action: 'indexing'; root: string; since: number }
  | { action: 'none'; reason: string; root?: string };

/**
 * Whether the session-start hook should start an auto-init, for a start
 * directory without a graph. Cheap: two or three git calls and small file
 * reads, no node:sqlite.
 */
export function checkAutoInit(start: string, env: NodeJS.ProcessEnv, now = Date.now()): AutoInitCheck {
  if (env.GLASSBOX_NESTED === '1') return { action: 'none', reason: 'nested glassbox call' };
  if (envFlag(env.GLASSBOX_AUTO_INIT) === false) return { action: 'none', reason: 'auto-init is off' };
  const root = gitWorkTreeRoot(start);
  if (!root) return { action: 'none', reason: 'not inside a git work tree' };
  if (forbiddenRoot(root, env)) return { action: 'none', reason: 'the repo root is the home directory or /', root };
  const config = loadProjectConfigSafe(root);
  if (!autoInitEnabled(env, config)) return { action: 'none', reason: 'auto-init is off', root };
  const storeExists = existsSync(join(root, STORE_DIR));
  if (storeExists && storeTrackedByGit(root)) return { action: 'none', reason: '.glassbox came with the repo (git tracks it)', root };
  if (storeExists) {
    const running = autoInitRunning(root, now);
    if (running) return { action: 'indexing', root, since: running.since };
  }
  if (existsSync(join(root, STORE_DIR, STORE_FILE))) return { action: 'none', reason: 'the repo already has a graph', root };
  if (storeExists) {
    const prev = readAutoInitState(root);
    const failed = prev?.error ?? prev?.skipped;
    if (failed && now - (prev?.finishedAt ?? 0) < AUTOINIT_RETRY_MS) return { action: 'none', reason: `last auto-init: ${failed}`, root };
  }
  const max = autoInitMaxFiles(env);
  const files = countSourceFiles(root);
  if (files === undefined) return { action: 'none', reason: 'could not count the source files', root };
  if (files === 0) return { action: 'none', reason: 'no supported source files', root };
  if (files > max) return { action: 'none', reason: `${files} source files, more than GLASSBOX_AUTO_INIT_MAX_FILES (${max})`, root };
  return { action: 'init', root, files };
}

export interface StartAutoInitOptions {
  env: NodeJS.ProcessEnv;
  /** The CLI entry file the detached process runs. */
  entry: string;
  /** Default: spawnDetached (detached, no stdio). */
  spawner?: DetachedSpawner;
  now?: number;
  host?: string;
}

export type StartAutoInitResult = { started: true; pid?: number } | { started: false; reason: string; indexing?: boolean };

/** The detached command: `node <entry> init --structure-only --auto --root <root> --quiet`, as an argument list (no shell). */
export function autoInitArgs(entry: string, root: string): string[] {
  return [entry, 'init', '--structure-only', '--auto', '--root', root, '--quiet'];
}

/**
 * Creates .glassbox/ (with its .gitignore), takes the auto-init lock and
 * starts the detached structure-only init, then hands the lock to that
 * process. Never throws.
 */
export function startAutoInit(root: string, opts: StartAutoInitOptions): StartAutoInitResult {
  const now = opts.now ?? Date.now();
  let locked = false;
  try {
    ensureStoreDirSync(root, STORE_DIR);
    if (!acquireLock(root, now, { name: AUTOINIT_LOCK_FILE, maxAgeMs: AUTOINIT_LOCK_MAX_AGE_MS })) {
      return { started: false, reason: 'another session is indexing', indexing: true };
    }
    locked = true;
    const prev = readAutoInitState(root) ?? {};
    writeAutoInitState(root, {
      ...(prev.fullInitAt !== undefined ? { fullInitAt: prev.fullInitAt } : {}),
      startedAt: now,
      auto: true,
      structureOnly: true,
    });
    const env: NodeJS.ProcessEnv = { ...opts.env };
    // The init itself makes no model calls; the worker it may start marks its own nested calls.
    delete env.GLASSBOX_NESTED;
    if (opts.host) env.GLASSBOX_HOST = opts.host;
    const pid = (opts.spawner ?? spawnDetached)(process.execPath, autoInitArgs(opts.entry, root), { cwd: root, env });
    // The lock now names the child, so it stays held for as long as the init runs.
    if (typeof pid === 'number' && pid > 0) handOverLock(root, AUTOINIT_LOCK_FILE, pid);
    return { started: true, ...(typeof pid === 'number' ? { pid } : {}) };
  } catch (err) {
    if (locked) releaseLock(root, AUTOINIT_LOCK_FILE);
    return { started: false, reason: `could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface StructureInitOptions {
  env: NodeJS.ProcessEnv;
  /** Started by the session-start hook: check the file cap, release the handed-over lock, maybe start the worker. */
  auto?: boolean;
  entry?: string;
  spawner?: DetachedSpawner;
  now?: () => number;
}

export interface StructureInitResult {
  files: number;
  nodes: number;
  edges: number;
  skipped?: string;
  /** Whether the tagging worker was started (auto only). */
  worker?: StartDecision;
}

/** Whether an auto-init may start the tagging worker: the worker is on and so are the edit hooks. */
export function autoInitWorkerAllowed(env: NodeJS.ProcessEnv, config: ProjectConfig): boolean {
  return workerEnabled(env, config) && editHooksEnabled(env);
}

/**
 * `glassbox init --structure-only`: parse the repo and write the graph (and
 * .glassbox/.gitignore). No backend is built, so no model call can happen,
 * and AGENTS.md and CLAUDE.md are never touched.
 */
export async function structureOnlyInit(root: string, opts: StructureInitOptions): Promise<StructureInitResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  ensureStoreDirSync(root, STORE_DIR);
  const prev = readAutoInitState(root) ?? {};
  const base: AutoInitState = {
    ...(prev.fullInitAt !== undefined ? { fullInitAt: prev.fullInitAt } : {}),
    startedAt: prev.startedAt ?? started,
    ...(opts.auto ? { auto: true } : {}),
  };
  try {
    const [{ GraphStore }, { indexRepo }, { walkRepo }] = await Promise.all([
      import('../memory/store.js'),
      import('../memory/source.js'),
      import('../graph/walk.js'),
    ]);
    if (opts.auto) {
      const max = autoInitMaxFiles(opts.env);
      const files = (await walkRepo(root)).length;
      if (files > max) {
        const skipped = `${files} source files, more than GLASSBOX_AUTO_INIT_MAX_FILES (${max})`;
        writeAutoInitState(root, { ...base, finishedAt: now(), skipped });
        return { files, nodes: 0, edges: 0, skipped };
      }
    }
    const store = GraphStore.open(root);
    let result: StructureInitResult;
    try {
      const { graph } = await indexRepo(root, store);
      result = { files: graph.files.length, nodes: graph.nodes.length, edges: graph.edges.length };
    } finally {
      store.close();
    }
    // A repo that had a full init keeps that: its tags and AGENTS.md block stay the reference.
    writeAutoInitState(root, {
      ...base,
      finishedAt: now(),
      structureOnly: prev.fullInitAt === undefined,
      files: result.files,
      nodes: result.nodes,
    });
    if (opts.auto && opts.entry) {
      const config = loadProjectConfigSafe(root);
      result.worker = autoInitWorkerAllowed(opts.env, config)
        ? maybeStartWorker(root, {
            env: opts.env,
            entry: opts.entry,
            ...(opts.spawner ? { spawner: opts.spawner } : {}),
            now: now(),
          })
        : { start: false, reason: 'tagging needs the worker and the edit hooks (enable_hooks) on' };
    }
    return result;
  } catch (err) {
    try {
      writeAutoInitState(root, { ...base, finishedAt: now(), error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    } catch {
      // Nothing more to record.
    }
    throw err;
  } finally {
    if (opts.auto) releaseLockOfPid(root, AUTOINIT_LOCK_FILE);
  }
}

/** Records a full `glassbox init`: the graph is no longer structure-only. Never throws. */
export function markFullInit(root: string, now = Date.now()): void {
  try {
    const prev = readAutoInitState(root);
    writeAutoInitState(root, { ...(prev ?? {}), structureOnly: false, fullInitAt: now });
  } catch {
    // Status then shows the older state; nothing depends on it.
  }
}

/**
 * The session-start code map for a repo with a graph: areas, entry points,
 * risky nodes (once tags exist) and how to use the MCP tools, at most
 * `maxChars`. Empty when the graph is empty or unreadable. No model calls.
 */
export async function sessionCodeMap(root: string, maxChars?: number): Promise<string> {
  const [{ GraphStore }, { buildAgentsSummary }, { renderCodeMap }, { isTagTarget, tagsFresh, defaultTagQuestions, inferAreas }] =
    await Promise.all([
      import('../memory/store.js'),
      import('../memory/summary.js'),
      import('../agents-md/render.js'),
      import('../memory/tags.js'),
    ]);
  const store = GraphStore.openForRead(root);
  if (!store) return '';
  try {
    const nodes = store.getNodes();
    if (nodes.length === 0) return '';
    const qids = Object.keys(defaultTagQuestions(inferAreas(nodes.map((n) => n.file))));
    const targets = nodes.filter(isTagTarget);
    const tagged = targets.filter((n) => tagsFresh(store, n, qids)).length;
    return renderCodeMap(buildAgentsSummary(store), {
      tagged,
      tagTargets: targets.length,
      ...(maxChars !== undefined ? { maxChars } : {}),
    });
  } finally {
    store.close();
  }
}
