import { describe, expect, it } from 'vitest';
import { runProcess, CliTimeoutError, unknownFlag } from '../../src/backends/process.js';
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

  it('rejects with ENOENT for a missing binary', async () => {
    await expect(runProcess('glassbox-no-such-binary', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
