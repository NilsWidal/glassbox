import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit } from '../backends/sampling.js';
import type { FakeRule } from '../backends/fake.js';
import { argmax } from '../engine/confidence.js';
import { decide } from '../engine/decide.js';
import { optionKeys, validateQuestion } from '../engine/questions.js';
import { occlude, optionProbability } from '../explain/occlusion.js';
import { buildScope, renderState, type Chunk } from '../scope.js';
import type { Backend, Question, QuestionType } from '../types.js';
import { fnv1a, seededRandom } from '../util/hash.js';
import { calibrateSamples, fitTemperature } from './fit.js';
import { computeMetrics, percentile, reliabilityTable, type Metrics, type Sample } from './metrics.js';

/** One benchmark question. `truth` is an option key: true/false, a choice key, or a level index. */
export interface BenchItem {
  id: string;
  /** Key into the bench file's `repos`. */
  repo: string;
  /** Files the question is about, relative to the repo root. */
  paths: string[];
  type: QuestionType;
  question: string;
  /** choice: option key -> description. */
  options?: Record<string, string>;
  /** score: levels, lowest first. */
  levels?: string[];
  truth: string;
  /** A line of the code that makes `truth` hold (author-constructed label). */
  evidence?: string;
}

export interface BenchFile {
  version: 1;
  note?: string;
  /** Repo name -> root, relative to the bench file or absolute. */
  repos: Record<string, string>;
  items: BenchItem[];
}

export interface BenchSet {
  file: string;
  /** Repo name -> absolute root. */
  repos: Record<string, string>;
  items: BenchItem[];
}

/** bench/ next to the package (works from src/ and dist/). */
export function defaultBenchDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench');
}

export function itemQuestion(item: BenchItem): Question {
  switch (item.type) {
    case 'yesno':
      return { type: 'yesno', instructions: item.question };
    case 'choice':
      return { type: 'choice', instructions: item.question, criteria: { ...(item.options ?? {}) } };
    case 'score':
      return { type: 'score', instructions: item.question, criteria: [...(item.levels ?? [])] };
  }
}

/** Throws on a malformed item: bad question, unknown repo, or a truth that is not an option. */
export function validateItem(item: BenchItem, repos: Record<string, string>): void {
  if (!item.id) throw new Error('bench item without an id');
  if (!repos[item.repo]) throw new Error(`bench item "${item.id}": unknown repo "${item.repo}"`);
  if (!item.paths?.length) throw new Error(`bench item "${item.id}": no paths`);
  const q = itemQuestion(item);
  validateQuestion(item.id, q);
  if (!optionKeys(q).includes(item.truth)) throw new Error(`bench item "${item.id}": truth "${item.truth}" is not an option`);
}

/** Loads and validates a bench file (default bench/questions.json). */
export async function loadBench(file = join(defaultBenchDir(), 'questions.json')): Promise<BenchSet> {
  const data = JSON.parse(await readFile(file, 'utf8')) as BenchFile;
  if (data.version !== 1 || !Array.isArray(data.items)) throw new Error(`${file}: not a version 1 bench file`);
  const repos: Record<string, string> = {};
  for (const [name, root] of Object.entries(data.repos ?? {})) repos[name] = isAbsolute(root) ? root : resolve(dirname(file), root);
  const seen = new Set<string>();
  for (const item of data.items) {
    validateItem(item, repos);
    if (seen.has(item.id)) throw new Error(`duplicate bench item id "${item.id}"`);
    seen.add(item.id);
  }
  return { file, repos, items: data.items };
}

/**
 * Harness-only fake answers: when the item's evidence line is in the state the
 * truth gets most of the mass (with seeded noise and some wrong answers), and
 * without it the answer is flat. This exercises every code path; the numbers
 * say nothing about any real model.
 */
export function benchFakeRules(items: readonly BenchItem[], seed = 7): FakeRule[] {
  // The same question can be asked about different files, so match on the evidence too.
  const byText = new Map<string, BenchItem[]>();
  for (const i of items) byText.set(i.question, [...(byText.get(i.question) ?? []), i]);
  return [
    (ctx) => {
      const list = byText.get(ctx.question.instructions);
      if (!list) return undefined;
      const item = list.find((i) => i.evidence && ctx.text.includes(i.evidence)) ?? list[0]!;
      const keys = ctx.options;
      if (!item.evidence || !ctx.text.includes(item.evidence)) return Object.fromEntries(keys.map((k) => [k, 1]));
      const rand = seededRandom((fnv1a(item.id) ^ seed) >>> 0);
      const strength = 0.5 + 0.45 * rand();
      const wrong = rand() < 0.15;
      const others = keys.filter((k) => k !== item.truth);
      const target = wrong ? others[Math.floor(rand() * others.length)]! : item.truth;
      const rest = (1 - strength) / Math.max(1, keys.length - 1);
      return Object.fromEntries(keys.map((k) => [k, k === target ? strength : rest]));
    },
  ];
}

export interface FaithfulnessOptions {
  /** Most yes/no items to test (they cost many calls). Default: all. */
  limit?: number;
  /** Occlusion budget per item, in backend calls (baseline and prefilter included). Default 10. */
  budget?: number;
  /** Chunks re-asked per item. Default 3. */
  topK?: number;
  /** Smallest |delta p| kept as a highlight. Default 0.05. */
  minDelta?: number;
  /** Deletion passes when p drops by at least this. Default 0.1. */
  minDrop?: number;
  /** Sufficiency passes when p falls by at most this. Default 0.1. */
  tolerance?: number;
}

export interface BenchOptions {
  backend: Backend;
  /** Option orders averaged per question. Default 2. */
  permutations?: number;
  /** Questions sent in one batched call. Default 8. */
  groupSize?: number;
  /** Batched decisions in flight at once. Default 2. */
  concurrency?: number;
  /** Only the first N items (for quick runs). */
  limit?: number;
  /** Faithfulness tests on yes/no items; false to skip. */
  faithfulness?: false | FaithfulnessOptions;
  /** Free-text caveats copied into the result (for example which model a CLI default resolved to). */
  notes?: string[];
  onProgress?: (msg: string) => void;
}

export interface ItemResult {
  id: string;
  type: QuestionType;
  truth: string;
  predicted?: string;
  correct?: boolean;
  /** Raw probabilities by option key. */
  probs?: Record<string, number>;
  pTruth?: number;
  error?: string;
}

export interface FaithItem {
  id: string;
  option: string;
  /** P(option) on the full state (the occlusion baseline). */
  pFull: number;
  highlights: string[];
  /** P(option) with every highlight removed. */
  pDeleted?: number;
  /** P(option) with only the highlights kept. */
  pSufficient?: number;
  /** P(option) with as many random non-highlight chunks removed (control). */
  pControl?: number;
  deletionPass?: boolean;
  sufficiencyPass?: boolean;
  error?: string;
}

export interface FaithfulnessSummary {
  tested: number;
  withHighlights: number;
  deletionRate: number;
  sufficiencyRate: number;
  /** Share of control deletions (random chunks) that also dropped p by minDrop. */
  controlDropRate: number;
  meanDeletionDrop: number;
  meanSufficiencyDrop: number;
  meanControlDrop: number;
  minDrop: number;
  tolerance: number;
  calls: number;
  items: FaithItem[];
}

type Scores = Omit<Metrics, 'bins'>;

export interface BenchResult {
  date: string;
  backend: string;
  model?: string;
  samples?: number;
  permutations: number;
  /** True for the fake backend: the numbers only prove the harness runs. */
  harnessOnly: boolean;
  notes?: string[];
  items: number;
  answered: number;
  failed: number;
  metrics: Scores;
  byType: Partial<Record<QuestionType, Scores>>;
  /** Temperature fitted on one half and scored on the other (2-fold), to show what calibration buys. */
  crossValidated?: { temperatures: number[]; metrics: Scores };
  reliability: string;
  /** Wall time of one batched decision (its option orders run in parallel). */
  latencyMs: { p50: number; p95: number; decisions: number };
  calls: { decide: number; faithfulness: number; total: number };
  faithfulness?: FaithfulnessSummary;
  results: ItemResult[];
}

interface Group {
  repo: string;
  paths: string[];
  items: BenchItem[];
}

function groupItems(items: readonly BenchItem[], size: number): Group[] {
  const byScope = new Map<string, BenchItem[]>();
  for (const it of items) {
    const key = `${it.repo}\u0000${[...it.paths].sort().join('\u0000')}`;
    byScope.set(key, [...(byScope.get(key) ?? []), it]);
  }
  const out: Group[] = [];
  for (const list of byScope.values()) {
    for (let i = 0; i < list.length; i += size) out.push({ repo: list[0]!.repo, paths: list[0]!.paths, items: list.slice(i, i + size) });
  }
  return out;
}

function strip(m: Metrics): Scores {
  const { bins: _bins, ...rest } = m;
  return rest;
}

function sampleOf(r: ItemResult, item: BenchItem): Sample | undefined {
  if (!r.probs) return undefined;
  const keys = optionKeys(itemQuestion(item));
  return { probs: keys.map((k) => r.probs![k] ?? 0), truth: keys.indexOf(item.truth) };
}

/** 2-fold cross-validated temperature scaling over the answered items (by index parity). */
function crossValidate(samples: Sample[]): BenchResult['crossValidated'] {
  if (samples.length < 16) return undefined;
  const folds = [samples.filter((_, i) => i % 2 === 0), samples.filter((_, i) => i % 2 === 1)];
  const temps: number[] = [];
  const scored: Sample[] = [];
  for (let f = 0; f < 2; f++) {
    const cal = fitTemperature(folds[1 - f]!);
    temps.push(cal.T);
    scored.push(...calibrateSamples(folds[f]!, cal));
  }
  return { temperatures: temps, metrics: strip(computeMetrics(scored)) };
}

async function faithfulness(
  bench: BenchSet,
  items: BenchItem[],
  results: Map<string, ItemResult>,
  backend: Backend,
  permutations: number,
  opts: FaithfulnessOptions,
  concurrency: number,
): Promise<FaithfulnessSummary> {
  const minDrop = opts.minDrop ?? 0.1;
  const tolerance = opts.tolerance ?? 0.1;
  const chosen = items.filter((i) => i.type === 'yesno' && results.get(i.id)?.predicted).slice(0, opts.limit ?? Infinity);
  let calls = 0;
  const decideOpts = { permutations };

  const pOf = async (state: string, q: Question, option: string) => {
    const res = await decide(state, { q }, backend, decideOpts);
    calls += res.calls;
    return optionProbability(res.answers.q!, option);
  };

  const out = await mapLimit(chosen, concurrency, async (item): Promise<FaithItem> => {
    const q = itemQuestion(item);
    const option = results.get(item.id)!.predicted!;
    try {
      const { chunks } = await buildScope({ paths: item.paths }, { root: bench.repos[item.repo]! });
      const occ = await occlude(chunks, q, option, backend, {
        budget: opts.budget ?? 10,
        topK: opts.topK ?? 3,
        minDelta: opts.minDelta ?? 0.05,
        decide: decideOpts,
      });
      calls += occ.calls;
      // Only spans that supported the answer count as highlights to delete.
      const hl = chunks.filter((c) => occ.highlights.some((h) => h.deltaP < 0 && h.file === c.file && h.startLine === c.startLine && h.endLine === c.endLine));
      const fi: FaithItem = { id: item.id, option, pFull: occ.baselineP, highlights: hl.map((c) => `${c.file}:${c.startLine}-${c.endLine}`) };
      if (hl.length === 0 || !Number.isFinite(occ.baselineP)) return fi;
      const hidden = new Set(hl.map((c) => c.id));
      const kept = chunks.filter((c) => hidden.has(c.id));
      const rest = chunks.filter((c) => !hidden.has(c.id));
      const control = pickControl(rest, hl.length, item.id);
      const [pDel, pSuf, pCtl] = await Promise.all([
        pOf(renderState(chunks, hidden), q, option),
        pOf(renderState(kept), q, option),
        control.length > 0 && rest.length > control.length ? pOf(renderState(chunks, new Set(control.map((c) => c.id))), q, option) : undefined,
      ]);
      fi.pDeleted = pDel;
      fi.pSufficient = pSuf;
      if (pCtl !== undefined) fi.pControl = pCtl;
      fi.deletionPass = occ.baselineP - pDel >= minDrop;
      fi.sufficiencyPass = occ.baselineP - pSuf <= tolerance;
      return fi;
    } catch (err) {
      return { id: item.id, option, pFull: NaN, highlights: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  const withHl = out.filter((f) => f.pDeleted !== undefined);
  const ctl = withHl.filter((f) => f.pControl !== undefined);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    tested: out.length,
    withHighlights: withHl.length,
    deletionRate: mean(withHl.map((f) => (f.deletionPass ? 1 : 0))),
    sufficiencyRate: mean(withHl.map((f) => (f.sufficiencyPass ? 1 : 0))),
    controlDropRate: mean(ctl.map((f) => (f.pFull - f.pControl! >= minDrop ? 1 : 0))),
    meanDeletionDrop: mean(withHl.map((f) => f.pFull - f.pDeleted!)),
    meanSufficiencyDrop: mean(withHl.map((f) => f.pFull - f.pSufficient!)),
    meanControlDrop: mean(ctl.map((f) => f.pFull - f.pControl!)),
    minDrop,
    tolerance,
    calls,
    items: out,
  };
}

/** Deterministic pick of `n` chunks for the random-deletion control. */
function pickControl(chunks: readonly Chunk[], n: number, seed: string): Chunk[] {
  const rand = seededRandom(fnv1a(seed));
  return [...chunks]
    .map((c) => ({ c, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * Runs the benchmark: questions about the same files go in one batched
 * decision, then accuracy, ECE, Brier and latency are computed, and the
 * faithfulness tests run on yes/no items.
 */
export async function runBench(bench: BenchSet, opts: BenchOptions): Promise<BenchResult> {
  const { backend } = opts;
  const permutations = Math.max(1, opts.permutations ?? 2);
  const items = bench.items.slice(0, opts.limit ?? bench.items.length);
  const groups = groupItems(items, Math.max(1, opts.groupSize ?? 8));
  const results = new Map<string, ItemResult>();
  const latencies: number[] = [];
  let decideCalls = 0;
  let done = 0;

  await mapLimit(groups, Math.max(1, opts.concurrency ?? 2), async (g) => {
    try {
      const { chunks } = await buildScope({ paths: g.paths }, { root: bench.repos[g.repo]! });
      const qs = Object.fromEntries(g.items.map((i) => [i.id, itemQuestion(i)]));
      const res = await decide(renderState(chunks), qs, backend, { permutations });
      decideCalls += res.calls;
      latencies.push(res.latencyMs);
      for (const rec of res.records) {
        const item = g.items.find((i) => i.id === rec.questionId)!;
        const keys = optionKeys(itemQuestion(item));
        const probs = keys.map((k) => rec.raw[k] ?? 0);
        const predicted = keys[argmax(probs)]!;
        results.set(item.id, {
          id: item.id,
          type: item.type,
          truth: item.truth,
          predicted,
          correct: predicted === item.truth,
          probs: rec.raw,
          pTruth: rec.raw[item.truth] ?? 0,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const i of g.items) results.set(i.id, { id: i.id, type: i.type, truth: i.truth, error: msg });
    }
    done += g.items.length;
    opts.onProgress?.(`bench  ${done}/${items.length} questions`);
  });

  const ordered = items.map((i) => results.get(i.id)!);
  const pairs = items.map((i, k) => ({ item: i, s: sampleOf(ordered[k]!, i) })).filter((x) => x.s !== undefined);
  const all = computeMetrics(pairs.map((x) => x.s!));
  const byType: BenchResult['byType'] = {};
  for (const t of ['yesno', 'choice', 'score'] as const) {
    const s = pairs.filter((x) => x.item.type === t).map((x) => x.s!);
    if (s.length) byType[t] = strip(computeMetrics(s));
  }

  let faith: FaithfulnessSummary | undefined;
  if (opts.faithfulness !== false) {
    opts.onProgress?.('faithfulness  deletion and sufficiency tests on yes/no items');
    faith = await faithfulness(bench, items, results, backend, permutations, opts.faithfulness ?? {}, Math.max(1, opts.concurrency ?? 2));
  }

  const cv = crossValidate(pairs.map((x) => x.s!));
  const samples = (backend as { samples?: unknown }).samples;
  const out: BenchResult = {
    date: new Date().toISOString(),
    backend: backend.name,
    permutations,
    harnessOnly: backend.name === 'fake',
    items: items.length,
    answered: pairs.length,
    failed: items.length - pairs.length,
    metrics: strip(all),
    byType,
    reliability: reliabilityTable(all),
    latencyMs: { p50: Math.round(percentile(latencies, 50)), p95: Math.round(percentile(latencies, 95)), decisions: latencies.length },
    calls: { decide: decideCalls, faithfulness: faith?.calls ?? 0, total: decideCalls + (faith?.calls ?? 0) },
    results: ordered,
  };
  if (backend.model !== undefined) out.model = backend.model;
  if (typeof samples === 'number') out.samples = samples;
  if (cv) out.crossValidated = cv;
  if (opts.notes?.length) out.notes = [...opts.notes];
  if (faith) out.faithfulness = faith;
  return out;
}

function f3(x: number): string {
  return Number.isFinite(x) ? x.toFixed(3) : '-';
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-';
}

/** Markdown report for bench/results/<backend>.md. */
export function renderBenchMarkdown(r: BenchResult): string {
  const lines: string[] = [];
  lines.push(`# glassbox bench: ${r.backend}${r.model ? ` (${r.model})` : ''}`);
  lines.push('');
  if (r.harnessOnly) {
    lines.push('**Harness-only run on the fake backend.** These numbers come from scripted answers and prove only that the bench runs end to end. They say nothing about any model.');
    lines.push('');
  }
  lines.push(`Date: ${r.date.slice(0, 10)}. Backend: \`${r.backend}\`. Model: \`${r.model ?? 'backend default'}\`.` +
    ` Samples per call: ${r.samples ?? 'n/a'}. Option orders: ${r.permutations}.`);
  lines.push('');
  for (const n of r.notes ?? []) lines.push(`Note: ${n}`, '');
  lines.push('Caveats: the labels are author-constructed from the fixture code (see bench/README.md), not an independent human-labeled set, and n is small, so treat these as rough numbers.');
  lines.push('');
  lines.push('| set | n | accuracy | ECE (15 bins) | Brier | NLL |');
  lines.push('|---|---|---|---|---|---|');
  const row = (name: string, m: Scores) => lines.push(`| ${name} | ${m.n} | ${f3(m.accuracy)} | ${f3(m.ece)} | ${f3(m.brier)} | ${f3(m.nll)} |`);
  row('all', r.metrics);
  for (const [t, m] of Object.entries(r.byType)) row(t, m);
  if (r.crossValidated) row(`all, temperature 2-fold CV (T=${r.crossValidated.temperatures.map((t) => t.toFixed(2)).join(', ')})`, r.crossValidated.metrics);
  const temps = r.crossValidated?.temperatures ?? [];
  if (temps.some((t) => t <= 0.05 || t >= 20)) {
    lines.push('');
    lines.push(
      temps.some((t) => t <= 0.05)
        ? 'A fitted temperature sits at the low edge of its search range (0.05). The answers here are almost all right and near-certain, so the fit sharpens them as far as it can; do not reuse it as a calibrator.'
        : 'A fitted temperature sits at the high edge of its search range (20): the answers carry almost no signal on this set.',
    );
  }
  lines.push('');
  lines.push('| latency p50 | latency p95 | batched decisions | backend calls (decide) | calls (faithfulness) | failed items |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| ${(r.latencyMs.p50 / 1000).toFixed(1)} s | ${(r.latencyMs.p95 / 1000).toFixed(1)} s | ${r.latencyMs.decisions} | ${r.calls.decide} | ${r.calls.faithfulness} | ${r.failed} |`);
  lines.push('');
  lines.push('Latency is the wall time of one batched decision: all questions about one scope, with its option orders run in parallel.');
  if (r.samples && r.samples > 1) lines.push(`Each backend call runs ${r.samples} samples in parallel.`);
  lines.push('');
  const f = r.faithfulness;
  if (f) {
    lines.push('## Faithfulness (yes/no items)');
    lines.push('');
    lines.push(`Deletion: remove every highlighted span; P(answer) should drop by at least ${f.minDrop}. Sufficiency: keep only the highlights; P(answer) should fall by at most ${f.tolerance}. Control: remove as many random non-highlighted spans.`);
    lines.push('');
    lines.push('| tested | with highlights | deletion pass | sufficiency pass | control drop rate | mean drop, deletion | mean drop, sufficiency | mean drop, control |');
    lines.push('|---|---|---|---|---|---|---|---|');
    lines.push(`| ${f.tested} | ${f.withHighlights} | ${pct(f.deletionRate)} | ${pct(f.sufficiencyRate)} | ${pct(f.controlDropRate)} | ${f3(f.meanDeletionDrop)} | ${f3(f.meanSufficiencyDrop)} | ${f3(f.meanControlDrop)} |`);
    lines.push('');
  }
  lines.push('## Reliability (all items)');
  lines.push('');
  lines.push('```');
  lines.push(r.reliability);
  lines.push('```');
  const failed = r.results.filter((x) => x.error);
  const wrong = r.results.filter((x) => x.correct === false);
  if (wrong.length) {
    lines.push('');
    lines.push('## Wrong answers');
    lines.push('');
    for (const w of wrong) lines.push(`- \`${w.id}\`: truth ${w.truth}, answered ${w.predicted} (p(truth)=${f3(w.pTruth ?? NaN)})`);
  }
  if (failed.length) {
    lines.push('');
    lines.push('## Failed items');
    lines.push('');
    for (const x of failed) lines.push(`- \`${x.id}\`: ${x.error}`);
  }
  return `${lines.join('\n')}\n`;
}
