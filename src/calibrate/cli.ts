import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FakeRule } from '../backends/fake.js';
import type { Backend } from '../types.js';
import { benchFakeRules, defaultBenchDir, loadBench, renderBenchMarkdown, runBench } from './bench.js';
import type { FitMethod } from './fit.js';
import { metricsLine, reliabilityTable, type Metrics } from './metrics.js';
import { calibrateFromLog, labelDecision } from './store.js';

/** The slice of the CLI's io these commands use. */
export interface ProofIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

export async function runLabel(id: string, answer: string, flags: { root?: string; json?: boolean }, io: ProofIo): Promise<number> {
  const r = await labelDecision(resolve(io.cwd, flags.root ?? '.'), id, answer);
  io.stdout(flags.json ? `${JSON.stringify(r, null, 2)}\n` : `labeled ${r.id}: truth=${r.truth}, model said ${r.predicted}${r.truth === r.predicted ? '' : ' (wrong)'}\n`);
  return 0;
}

export interface CalibrateFlags {
  root?: string;
  method?: FitMethod;
  minLabels?: number;
  dryRun?: boolean;
  json?: boolean;
}

function withBins(m: Omit<Metrics, 'bins'>, bins: Metrics['bins']): Metrics {
  return { ...m, bins };
}

export async function runCalibrate(flags: CalibrateFlags, io: ProofIo): Promise<number> {
  const root = resolve(io.cwd, flags.root ?? '.');
  const r = await calibrateFromLog(root, {
    ...(flags.method ? { method: flags.method } : {}),
    ...(flags.minLabels !== undefined ? { minLabels: flags.minLabels } : {}),
    ...(flags.dryRun ? { dryRun: true } : {}),
  });
  if (flags.json) {
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    return r.entries.length ? 0 : 1;
  }
  if (r.entries.length === 0) {
    io.stderr('glassbox: no labeled decisions yet; label some with `glassbox label <decisionId> <answer>`\n');
    return 1;
  }
  const out: string[] = [];
  for (const e of r.entries) {
    const cal = e.calibrator;
    const desc = cal.kind === 'temperature' ? `temperature T=${cal.T}` : cal.kind === 'platt' ? `platt a=${cal.a} b=${cal.b}` : 'identity (too few labels)';
    out.push(`${e.questionId}  ${e.backend}${e.model ? ` (${e.model})` : ''}  ${desc}`);
    out.push(`  before  ${metricsLine(withBins(e.before, e.beforeBins))}`);
    out.push(`  after   ${metricsLine(withBins(e.after, e.afterBins))}  (in-sample)`);
    out.push(reliabilityTable(withBins(e.before, e.beforeBins)).replace(/^/gm, '  '));
  }
  out.push(r.file ? `saved ${r.file}` : 'dry run, nothing saved');
  io.stdout(`${out.join('\n')}\n`);
  return 0;
}

export interface BenchFlags {
  file?: string;
  out?: string;
  limit?: number;
  groupSize?: number;
  concurrency?: number;
  permutations?: number;
  faithfulness: boolean;
  faithLimit?: number;
  faithBudget?: number;
  write: boolean;
  json?: boolean;
  quiet?: boolean;
  note?: string[];
}

/**
 * Runs the bench and writes bench/results/<backend>.json and .md. The
 * backend factory gets harness rules, used only by the fake backend.
 */
export async function runBenchCommand(flags: BenchFlags, io: ProofIo, makeBackend: (fakeRules: FakeRule[]) => Backend): Promise<number> {
  const file = flags.file ? resolve(io.cwd, flags.file) : join(defaultBenchDir(), 'questions.json');
  const bench = await loadBench(file);
  const backend = makeBackend(benchFakeRules(bench.items));
  const r = await runBench(bench, {
    backend,
    ...(flags.permutations !== undefined ? { permutations: flags.permutations } : {}),
    ...(flags.groupSize !== undefined ? { groupSize: flags.groupSize } : {}),
    ...(flags.concurrency !== undefined ? { concurrency: flags.concurrency } : {}),
    ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
    ...(flags.note?.length ? { notes: flags.note } : {}),
    faithfulness: flags.faithfulness
      ? { ...(flags.faithLimit !== undefined ? { limit: flags.faithLimit } : {}), ...(flags.faithBudget !== undefined ? { budget: flags.faithBudget } : {}) }
      : false,
    ...(flags.quiet || flags.json ? {} : { onProgress: (m: string) => io.stderr(`${m}\n`) }),
  });
  const md = renderBenchMarkdown(r);
  if (flags.write) {
    const dir = flags.out ? resolve(io.cwd, flags.out) : join(dirname(file), 'results');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${r.backend}.json`), `${JSON.stringify(r, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, `${r.backend}.md`), md, 'utf8');
    if (!flags.json) io.stderr(`wrote ${join(dir, `${r.backend}.json`)} and .md\n`);
  }
  io.stdout(flags.json ? `${JSON.stringify(r, null, 2)}\n` : md);
  return r.answered > 0 ? 0 : 1;
}
