import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { findOnPath } from './backends/process.js';
import { resolveMode } from './modes.js';
import { maybeStartWorker, type DetachedSpawner } from './worker/index.js';

export const AGENTS = ['claude', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];

const HOST: Readonly<Record<Agent, string>> = { claude: 'claude-code', codex: 'codex' };
const BIN_ENV: Readonly<Record<Agent, string>> = { claude: 'GLASSBOX_CLAUDE_BIN', codex: 'GLASSBOX_CODEX_BIN' };

export function isAgent(v: string): v is Agent {
  return (AGENTS as readonly string[]).includes(v);
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Runs a command in the foreground with the terminal attached (args array, no shell). Injectable for tests. */
export type ForegroundSpawner = (cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ChildExit>;

const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export const spawnForeground: ForegroundSpawner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: opts.env, stdio: 'inherit' });
    // The agent owns the terminal: Ctrl-C reaches it directly, so glassbox only
    // passes signals on and waits for it to exit.
    const handlers = FORWARDED.map((sig) => {
      const h = () => {
        if (sig !== 'SIGINT') child.kill(sig);
      };
      process.on(sig, h);
      return [sig, h] as const;
    });
    const cleanup = () => {
      for (const [sig, h] of handlers) process.off(sig, h);
    };
    child.on('error', (e) => {
      cleanup();
      reject(e);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });

export interface LaunchOptions {
  agent: Agent;
  /** Passed to the agent untouched. */
  args: readonly string[];
  root: string;
  /** Where the agent runs. Default the root. */
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** --mode; else the mode resolved from GLASSBOX_MODE, config or the plugin option. */
  mode?: string;
  /** Refresh the graph and AGENTS.md when files changed since the last parse. Default true. */
  refresh?: boolean;
  /** CLI entry file, to start the background worker. */
  entry?: string;
  spawner?: ForegroundSpawner;
  workerSpawner?: DetachedSpawner;
  /** Progress and warnings (stderr). */
  log: (line: string) => void;
}

export interface LaunchPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * True when a file the graph knows changed or disappeared after the last full
 * parse. Files added since are not seen here; the next `glassbox index` picks them up.
 */
export async function graphOutOfDate(root: string): Promise<boolean> {
  const { GraphStore } = await import('./memory/store.js');
  const store = GraphStore.openForRead(root);
  if (!store) return false;
  try {
    const at = store.indexedAt();
    if (at === undefined) return true;
    for (const n of store.getNodes({ kind: 'file' })) {
      try {
        if (statSync(join(root, n.file)).mtimeMs > at) return true;
      } catch {
        return true;
      }
    }
    return false;
  } finally {
    store.close();
  }
}

/** The binary, args and env the agent is started with. Throws when the binary is not found. */
export function launchPlan(opts: Pick<LaunchOptions, 'agent' | 'args' | 'env' | 'mode' | 'root'>): LaunchPlan {
  const name = opts.env[BIN_ENV[opts.agent]]?.trim() || opts.agent;
  const bin = findOnPath(name, opts.env);
  if (!bin) throw new Error(`"${name}" was not found on PATH; install it or set ${BIN_ENV[opts.agent]}`);
  const resolved = resolveMode({ explicit: opts.mode, env: opts.env, root: opts.root });
  const env: NodeJS.ProcessEnv = { ...opts.env, GLASSBOX_HOST: HOST[opts.agent] };
  if (resolved.source !== 'default') env.GLASSBOX_MODE = resolved.mode;
  // The agent is a normal session, not one of glassbox's own nested calls.
  delete env.GLASSBOX_NESTED;
  return { bin, args: [...opts.args], env };
}

/**
 * `glassbox run claude|codex [args...]`: brings the graph and the AGENTS.md
 * block up to date when files changed (no model calls), may start the
 * background re-tagging worker, then runs the agent with its args untouched
 * and returns its exit code.
 */
export async function launch(opts: LaunchOptions): Promise<number> {
  let plan: LaunchPlan;
  try {
    plan = launchPlan(opts);
  } catch (err) {
    opts.log(`glassbox: ${err instanceof Error ? err.message : String(err)}`);
    return 127;
  }
  const { hasGraph, refresh } = await import('./memory/refresh.js');
  if (hasGraph(opts.root)) {
    if (opts.refresh !== false) {
      try {
        if (await graphOutOfDate(opts.root)) {
          const r = await refresh(opts.root, { syncMd: { claudeMd: false } });
          if (r.sync) opts.log(`glassbox: graph refreshed (+${r.sync.added.length} ~${r.sync.changed.length} -${r.sync.removed.length})`);
        }
      } catch (err) {
        opts.log(`glassbox: refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (opts.entry) {
      maybeStartWorker(opts.root, {
        env: plan.env,
        entry: opts.entry,
        host: HOST[opts.agent],
        ...(opts.workerSpawner ? { spawner: opts.workerSpawner } : {}),
      });
    }
  }
  const exit = await (opts.spawner ?? spawnForeground)(plan.bin, plan.args, { cwd: opts.cwd ?? opts.root, env: plan.env });
  if (exit.code !== null) return exit.code;
  const signals: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return 128 + (exit.signal ? (signals[exit.signal] ?? 1) : 1);
}
