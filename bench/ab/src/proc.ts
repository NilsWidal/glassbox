// Spawns a program with an argument list (never a shell string) and collects its output.
import { spawn } from 'node:child_process';

export interface ProcRequest {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Without it stdin is closed at once. */
  stdin?: string;
  timeoutMs: number;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallMs: number;
  /** Set when the program could not start (for example, not on PATH). */
  spawnError?: string;
}

export type RunProc = (req: ProcRequest) => Promise<ProcResult>;

const MAX_CAPTURE = 64 * 1024 * 1024;

export const runProc: RunProc = (req) =>
  new Promise((resolveResult) => {
    const started = performance.now();
    const child = spawn(req.cmd, req.args, {
      cwd: req.cwd,
      env: req.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let spawnError: string | undefined;
    child.stdout.on('data', (b: Buffer) => {
      if (outLen < MAX_CAPTURE) out.push(b);
      outLen += b.length;
    });
    child.stderr.on('data', (b: Buffer) => {
      if (errLen < MAX_CAPTURE) err.push(b);
      errLen += b.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, req.timeoutMs);
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(req.stdin ?? '');
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        wallMs: Math.round(performance.now() - started),
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
