import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command (args array, never a shell string). Injectable so tests never spawn real CLIs. */
export type ProcessRunner = (cmd: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

export class CliNotFoundError extends Error {
  constructor(readonly command: string, hint: string) {
    super(`"${command}" was not found on PATH. ${hint}`);
    this.name = 'CliNotFoundError';
  }
}

export class CliTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`"${command}" did not finish within ${timeoutMs} ms`);
    this.name = 'CliTimeoutError';
  }
}

export class CliCallError extends Error {
  constructor(message: string, readonly stderr = '') {
    super(message);
    this.name = 'CliCallError';
  }
}

const MAX_TREE = 256;

/**
 * Pids of every process below `pid`, found with `pgrep -P` level by level
 * (at most 256). Empty on Windows or when pgrep is missing.
 */
export function descendantPids(pid: number): number[] {
  if (process.platform === 'win32') return [];
  const out: number[] = [];
  let level = [pid];
  for (let depth = 0; depth < 16 && level.length && out.length < MAX_TREE; depth++) {
    const next: number[] = [];
    for (const p of level) {
      const r = spawnSync('pgrep', ['-P', String(p)], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      if (r.status !== 0 || typeof r.stdout !== 'string') continue;
      for (const line of r.stdout.split('\n')) {
        const n = Number(line.trim());
        if (Number.isInteger(n) && n > 0 && !out.includes(n)) next.push(n);
      }
    }
    out.push(...next.slice(0, MAX_TREE - out.length));
    level = next;
  }
  return out;
}

function signalPid(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a process and everything it started: SIGTERM to the whole tree
 * (collected before any of it dies, since orphans lose their parent link),
 * then SIGKILL after `graceMs` to whatever is still there. On Windows,
 * `taskkill /T /F`.
 */
export function killTree(pid: number | undefined, graceMs = 1500): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  const tree = [pid, ...descendantPids(pid)];
  for (const p of tree) signalPid(p, 'SIGTERM');
  // Kept referenced on purpose: the SIGKILL must still happen if this process is about to exit.
  setTimeout(() => {
    for (const p of tree) if (signalPid(p, 0)) signalPid(p, 'SIGKILL');
  }, graceMs);
}

export const runProcess: ProcessRunner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason ?? new Error('aborted'));
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killTree(child.pid);
          finish(() => reject(new CliTimeoutError(cmd, opts.timeoutMs!)));
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      killTree(child.pid);
      finish(() => reject(opts.signal?.reason ?? new Error('aborted')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(e)));
    child.on('close', (code) =>
      finish(() => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })),
    );
    // A child that exits before reading stdin raises EPIPE; the close handler reports the real outcome.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });

export function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Full path of an executable on PATH, or undefined. */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  // An explicit path is checked as is.
  const dirs = /[\\/]/.test(cmd) ? [''] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = dir ? join(dir, cmd + ext) : cmd + ext;
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

/** Last few non-empty lines of stderr, for error messages. */
export function tail(text: string, lines = 5): string {
  return text.trim().split('\n').filter(Boolean).slice(-lines).join('\n');
}

/**
 * Flag the CLI rejected as unknown, if any. Lets a backend drop an optional
 * flag and retry on older CLI versions instead of failing outright.
 */
export function unknownFlag(stderr: string): string | undefined {
  const m = /unknown (?:option|argument)\s+'?(--[a-z0-9-]+)/i.exec(stderr) ?? /unexpected argument '(--[a-z0-9-]+)'/i.exec(stderr);
  return m?.[1];
}

/** API keys glassbox holds for its own API backends; host CLI children never need them. */
const GLASSBOX_ONLY_KEYS = /^(GLASSBOX_ANTHROPIC_API_KEY|GLASSBOX_OPENAI_API_KEY|CLAUDE_PLUGIN_OPTION_\w*API_KEY)$/;

/**
 * Env for a nested host CLI call: the parent env minus glassbox-held API keys,
 * plus GLASSBOX_NESTED so our own plugin hooks skip work inside the call.
 * Keys the user exported themselves (ANTHROPIC_API_KEY, OPENAI_API_KEY) are kept.
 */
export function cliChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!GLASSBOX_ONLY_KEYS.test(k)) out[k] = v;
  out.GLASSBOX_NESTED = '1';
  return out;
}

/**
 * Model ids are names, never flags: letters, digits and . _ : / @ - only, not
 * starting with -, with an optional bracketed suffix such as Claude Code's
 * `opus[1m]`.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*(?:\[[A-Za-z0-9]+\])?$/;

export function checkModelId(model: string): string {
  if (!MODEL_ID.test(model)) throw new Error(`invalid model id "${model}"`);
  return model;
}
