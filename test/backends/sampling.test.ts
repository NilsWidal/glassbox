import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess, CliTimeoutError, descendantPids, unknownFlag } from '../../src/backends/process.js';
import { averageSamples, mapLimit, resolveSamples, resolveTimeoutMs, runSamples } from '../../src/backends/sampling.js';

describe('averageSamples', () => {
  it('normalizes each sample, averages and renormalizes', () => {
    const out = averageSamples([{ q: { A: 2, B: 2 } }, { q: { A: 1, B: 0 } }], { q: ['A', 'B'] });
    expect(out.q!.A).toBeCloseTo(0.75);
    expect(out.q!.B).toBeCloseTo(0.25);
  });

  it('skips samples that miss a question or are all zero', () => {
    const out = averageSamples([{ q: { A: 0, B: 0 } }, {}, { q: { A: 0.2, B: 0.8 } }], { q: ['A', 'B'], r: ['A', 'B'] });
    expect(out.q).toEqual({ A: 0.2, B: 0.8 });
    expect(out.r).toBeUndefined();
  });

  it('ignores negative and non-finite values', () => {
    const out = averageSamples([{ q: { A: -1, B: Number.NaN, C: 1 } }], { q: ['A', 'B', 'C'] });
    expect(out.q).toEqual({ A: 0, B: 0, C: 1 });
  });
});

describe('sampling helpers', () => {
  it('runSamples keeps survivors and throws when all fail', async () => {
    expect(await runSamples(3, async (i) => (i === 1 ? Promise.reject(new Error('x')) : i))).toEqual([0, 2]);
    await expect(runSamples(2, async () => Promise.reject(new Error('all bad')))).rejects.toThrow('all bad');
  });

  it('mapLimit preserves order and caps concurrency', async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return x * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('reads samples and timeout from env with sane bounds', () => {
    expect(resolveSamples({})).toBe(3);
    expect(resolveSamples({ GLASSBOX_SAMPLES: '5' })).toBe(5);
    expect(resolveSamples({ GLASSBOX_SAMPLES: '0' })).toBe(3);
    expect(resolveSamples({ GLASSBOX_SAMPLES: '99' })).toBe(16);
    expect(resolveTimeoutMs({ GLASSBOX_TIMEOUT_MS: '5000' })).toBe(5000);
  });

  it('recognizes unknown-flag errors from both CLIs', () => {
    expect(unknownFlag("error: unknown option '--safe-mode'")).toBe('--safe-mode');
    expect(unknownFlag("error: unexpected argument '--ephemeral' found")).toBe('--ephemeral');
    expect(unknownFlag('some other failure')).toBeUndefined();
  });
});

// Uses the local node binary, never a model CLI.
describe('runProcess', () => {
  it('pipes stdin, captures stdout, stderr and exit code', async () => {
    const r = await runProcess(process.execPath, [
      '-e',
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s.toUpperCase());process.stderr.write("e");process.exit(3)})',
    ], { input: 'hi' });
    expect(r).toEqual({ code: 3, stdout: 'HI', stderr: 'e' });
  });

  it('times out', async () => {
    await expect(runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 100 })).rejects.toBeInstanceOf(CliTimeoutError);
  });

  // A child that starts a grandchild (like `claude -p` starting its own tools) and writes its pid.
  const PARENT = (pidFile: string) =>
    `const {spawn}=require('child_process');const fs=require('fs');` +
    `const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});` +
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},30000);`;

  async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return check();
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it.skipIf(process.platform === 'win32')('kills the whole process tree on abort and on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glassbox-tree-'));
    try {
      for (const how of ['abort', 'timeout'] as const) {
        const pidFile = join(dir, `${how}.pid`);
        const abort = new AbortController();
        const run = runProcess(process.execPath, ['-e', PARENT(pidFile)], how === 'abort' ? { signal: abort.signal } : { timeoutMs: 1500 });
        run.catch(() => {});
        expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0)).toBe(true);
        const grandchild = Number(readFileSync(pidFile, 'utf8'));
        expect(alive(grandchild)).toBe(true);
        if (how === 'abort') abort.abort(new Error('stop'));
        await expect(run).rejects.toBeDefined();
        expect(await waitFor(() => !alive(grandchild))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('finds descendants, and none for a process without children', () => {
    expect(descendantPids(2 ** 22 + 12345)).toEqual([]);
  });

  it('rejects with ENOENT for a missing binary', async () => {
    await expect(runProcess('glassbox-no-such-binary', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
