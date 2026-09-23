import type { LabelDistribution } from '../types.js';

export const DEFAULT_SAMPLES = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;

/** K from GLASSBOX_SAMPLES (1 to 16), else the default. */
export function resolveSamples(env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_SAMPLES): number {
  return positiveInt(env.GLASSBOX_SAMPLES, fallback, 16);
}

/** Per-call timeout from GLASSBOX_TIMEOUT_MS, else the default. */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_TIMEOUT_MS): number {
  return positiveInt(env.GLASSBOX_TIMEOUT_MS, fallback, 3_600_000);
}

function positiveInt(v: string | undefined, fallback: number, max: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

/**
 * Averages K sampled answers per question. Each sample is normalized first so
 * one sample cannot outweigh another, then the mean is renormalized. Samples
 * that miss a question (or give it all zeros) are skipped for that question.
 */
export function averageSamples(
  samples: ReadonlyArray<Record<string, LabelDistribution>>,
  labels: Record<string, string[]>,
): Record<string, LabelDistribution> {
  const out: Record<string, LabelDistribution> = {};
  for (const [id, ls] of Object.entries(labels)) {
    const sum = ls.map(() => 0);
    let used = 0;
    for (const s of samples) {
      const dist = s[id];
      if (!dist) continue;
      const vals = ls.map((l) => clean(dist[l]));
      const total = vals.reduce((a, b) => a + b, 0);
      if (total <= 0) continue;
      vals.forEach((v, i) => (sum[i]! += v / total));
      used++;
    }
    if (used === 0) continue;
    const total = sum.reduce((a, b) => a + b, 0);
    out[id] = Object.fromEntries(ls.map((l, i) => [l, sum[i]! / total]));
  }
  return out;
}

function clean(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Runs `k` samples in parallel. Partial failure is tolerated (the survivors are
 * used); if every sample fails, the first error is thrown.
 */
export async function runSamples<T>(k: number, sample: (i: number) => Promise<T>): Promise<T[]> {
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, k) }, (_, i) => sample(i)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<T>> => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length > 0) return ok;
  throw (settled[0] as PromiseRejectedResult).reason;
}

/** Runs tasks with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
