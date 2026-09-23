import { spawn } from 'node:child_process';
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
          child.kill('SIGTERM');
          finish(() => reject(new CliTimeoutError(cmd, opts.timeoutMs!)));
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      child.kill('SIGTERM');
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
