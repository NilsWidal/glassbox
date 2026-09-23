import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DECISION_LOG, STORE_DIR, readDecisionLog } from '../ask.js';
import { optionKeys } from '../engine/questions.js';
import type { Backend, Calibrator, DecisionRecord, Question } from '../types.js';
import { calibrateSamples, fitCalibrator, type FitMethod } from './fit.js';
import { computeMetrics, type Metrics, type Sample } from './metrics.js';

export const CALIBRATION_FILE = 'calibration.json';

export interface CalibrationEntry {
  questionId: string;
  backend: string;
  /** Empty string when the backend reported no model id. */
  model: string;
  calibrator: Calibrator;
  /** Labeled decisions the calibrator was fitted on. */
  n: number;
  /** In-sample metrics before and after; small n makes "after" optimistic. */
  before: Omit<Metrics, 'bins'>;
  after: Omit<Metrics, 'bins'>;
}

export interface CalibrationFile {
  version: 1;
  fittedAt: string;
  entries: CalibrationEntry[];
}

export function calibrationPath(root: string): string {
  return join(root, STORE_DIR, CALIBRATION_FILE);
}

export function decisionLogPath(root: string): string {
  return join(root, STORE_DIR, DECISION_LOG);
}

/** Reads .glassbox/calibration.json; undefined when missing or unreadable. */
export async function loadCalibration(root: string): Promise<CalibrationFile | undefined> {
  try {
    const data = JSON.parse(await readFile(calibrationPath(root), 'utf8')) as CalibrationFile;
    return data && data.version === 1 && Array.isArray(data.entries) ? data : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCalibration(root: string, file: CalibrationFile): Promise<string> {
  const path = calibrationPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return path;
}

/** Question id -> calibrator for one backend and model, as decide() takes them. */
export function calibratorsFor(file: CalibrationFile | undefined, backend: string, model: string | undefined): Record<string, Calibrator> {
  const out: Record<string, Calibrator> = {};
  for (const e of file?.entries ?? []) {
    if (e.backend === backend && e.model === (model ?? '') && e.calibrator.kind !== 'identity') out[e.questionId] = e.calibrator;
  }
  return out;
}

/** Loads the calibrators that match a backend; empty when there is no calibration file. */
export async function loadCalibrators(root: string, backend: Pick<Backend, 'name' | 'model'>): Promise<Record<string, Calibrator>> {
  return calibratorsFor(await loadCalibration(root), backend.name, backend.model);
}

/** Ground truth of a record: `truth`, or a `label` field written by other tools. */
export function recordTruth(r: DecisionRecord): string | undefined {
  const t = r.truth ?? (r as { label?: unknown }).label;
  return typeof t === 'string' ? t : undefined;
}

/**
 * Maps a user's answer to an option key: yes/no/true/false/y/n for yesno, a
 * key for choice, and a level index or the level's text for score.
 */
export function normalizeTruth(question: Question, answer: string): string {
  const a = answer.trim();
  const keys = optionKeys(question);
  if (question.type === 'yesno') {
    const v = a.toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(v)) return 'true';
    if (['no', 'n', 'false', '0'].includes(v)) return 'false';
  } else if (keys.includes(a)) return a;
  else if (question.type === 'score') {
    const i = question.criteria.findIndex((c) => c.toLowerCase() === a.toLowerCase());
    if (i >= 0) return String(i);
  } else {
    const k = keys.find((key) => key.toLowerCase() === a.toLowerCase());
    if (k) return k;
  }
  const allowed = question.type === 'yesno' ? 'yes or no' : question.type === 'score' ? `a level 0 to ${keys.length - 1} or its text` : keys.join(', ');
  throw new Error(`"${answer}" is not an option of this question (expected ${allowed})`);
}

export interface LabelResult {
  id: string;
  truth: string;
  /** The answer's winning option, to show whether the model was right. */
  predicted: string;
  file: string;
}

/**
 * Sets the ground truth on one logged decision (by id or unique id prefix) and
 * rewrites the log atomically. Relabeling replaces the earlier truth.
 */
export async function labelDecision(root: string, idPrefix: string, answer: string, logFile = decisionLogPath(root)): Promise<LabelResult> {
  const records = await readDecisionLog(logFile);
  const matches = records.filter((r) => r.id !== undefined && r.id.startsWith(idPrefix));
  if (matches.length === 0) throw new Error(`no logged decision with id "${idPrefix}" in ${logFile}`);
  if (matches.length > 1 && !matches.every((m) => m.id === matches[0]!.id)) {
    throw new Error(`"${idPrefix}" matches ${matches.length} decisions; give more characters`);
  }
  const truth = normalizeTruth(matches[0]!.question, answer);
  for (const m of matches) m.truth = truth;
  const tmp = `${logFile}.${process.pid}.tmp`;
  await writeFile(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
  await rename(tmp, logFile);
  const keys = optionKeys(matches[0]!.question);
  const raw = keys.map((k) => matches[0]!.raw[k] ?? 0);
  const predicted = keys[raw.indexOf(Math.max(...raw))]!;
  return { id: matches[0]!.id!, truth, predicted, file: logFile };
}

/** A labeled record as a sample over its raw (uncalibrated) probabilities; undefined when unusable. */
export function recordSample(r: DecisionRecord): Sample | undefined {
  const truth = recordTruth(r);
  if (truth === undefined || !r.question || !r.raw) return undefined;
  const keys = optionKeys(r.question);
  const t = keys.indexOf(truth);
  if (t < 0) return undefined;
  const probs = keys.map((k) => r.raw[k] ?? 0);
  if (!(probs.reduce((a, b) => a + b, 0) > 0)) return undefined;
  return { probs, truth: t };
}

export interface FitGroup {
  questionId: string;
  backend: string;
  model: string;
  samples: Sample[];
}

/** Groups labeled records by (questionId, backend, model). */
export function groupLabeled(records: readonly DecisionRecord[]): FitGroup[] {
  const groups = new Map<string, FitGroup>();
  for (const r of records) {
    const s = recordSample(r);
    if (!s) continue;
    const model = r.model ?? '';
    const key = `${r.questionId}\u0000${r.backend}\u0000${model}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { questionId: r.questionId, backend: r.backend, model, samples: [] }));
    g.samples.push(s);
  }
  return [...groups.values()];
}

export interface FitReport {
  /** Labeled records found in the log. */
  labeled: number;
  entries: Array<CalibrationEntry & { beforeBins: Metrics['bins']; afterBins: Metrics['bins'] }>;
}

function strip(m: Metrics): Omit<Metrics, 'bins'> {
  const { bins: _bins, ...rest } = m;
  return rest;
}

/** Fits one calibrator per (questionId, backend, model) group of labeled records. */
export function fitFromRecords(records: readonly DecisionRecord[], opts: { method?: FitMethod; minLabels?: number } = {}): FitReport {
  const groups = groupLabeled(records);
  const entries = groups.map((g) => {
    const calibrator = fitCalibrator(g.samples, opts.method ?? 'auto', opts.minLabels);
    const before = computeMetrics(g.samples);
    const after = computeMetrics(calibrateSamples(g.samples, calibrator));
    return {
      questionId: g.questionId,
      backend: g.backend,
      model: g.model,
      calibrator,
      n: g.samples.length,
      before: strip(before),
      after: strip(after),
      beforeBins: before.bins,
      afterBins: after.bins,
    };
  });
  return { labeled: groups.reduce((a, g) => a + g.samples.length, 0), entries };
}

/** Reads the decision log, fits, and (unless dryRun) writes .glassbox/calibration.json. */
export async function calibrateFromLog(
  root: string,
  opts: { method?: FitMethod; minLabels?: number; dryRun?: boolean; logFile?: string } = {},
): Promise<FitReport & { file?: string }> {
  const records = await readDecisionLog(opts.logFile ?? decisionLogPath(root));
  const report = fitFromRecords(records, opts);
  if (opts.dryRun || report.entries.length === 0) return report;
  const file = await saveCalibration(root, {
    version: 1,
    fittedAt: new Date().toISOString(),
    entries: report.entries.map(({ beforeBins: _b, afterBins: _a, ...e }) => e),
  });
  return { ...report, file };
}
