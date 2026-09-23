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
/** Time between SIGTERM and SIGKILL when a run is stopped. */
export const KILL_GRACE_MS = 5000;

/** Process groups of children still running, killed if this process exits first. */
const live = new Set<number>();
let exitHook = false;

/** Sends a signal to a whole process group (the child and everything it started). */
export function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, sig);
  } catch {
    // The group is already gone.
  }
}

function track(pid: number | undefined): void {
  if (pid === undefined) return;
  live.add(pid);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const p of live) killGroup(p, 'SIGKILL');
    });
  }
}

export const runProc: RunProc = (req) =>
  new Promise((resolveResult) => {
    const started = performance.now();
    // Its own process group, so a timeout stops the agent and every process it started
    // (shells, test runs), not just the direct child.
    const child = spawn(req.cmd, req.args, {
      cwd: req.cwd,
      env: req.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    track(child.pid);
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
      killGroup(child.pid, 'SIGTERM');
      // Referenced and never cancelled, so the group SIGKILL happens even after the child exits.
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }, req.timeoutMs);
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(req.stdin ?? '');
    child.on('close', (code) => {
      clearTimeout(timer);
      // Anything the program left running in its group (a background server, a stuck test)
      // must not outlive the run and write into a workspace that is about to be deleted. The
      // delayed SIGKILL of a timeout is kept too: it goes to the group, not the direct child,
      // so it still matters after the child itself is gone.
      killGroup(child.pid, 'SIGKILL');
      if (child.pid !== undefined) live.delete(child.pid);
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
