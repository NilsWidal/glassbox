import type {
  Backend,
  BatchQuestion,
  DecideOptions,
  DecideResult,
  DecisionRecord,
  LabelDistribution,
  Question,
  State,
} from '../types.js';
import { fnv1a, hashState } from '../util/hash.js';
import { buildAnswer, toRecord } from './answer.js';
import { resolveBands } from './bands.js';
import { applyCalibrator } from './calibrate.js';
import { normalize } from './confidence.js';
import { labelsFor } from './labels.js';
import { optionKeys, validateQuestion } from './questions.js';
import { permutationIndexes } from './shuffle.js';

export const DEFAULT_PERMUTATIONS = 2;

/** The batch sent for permutation `p`: every question with its options in that order. */
export function batchForPermutation(
  questions: Record<string, Question>,
  p: number,
  seed: number,
): Record<string, BatchQuestion> {
  const out: Record<string, BatchQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    const keys = optionKeys(question);
    const order = permutationIndexes(keys.length, p, (seed ^ fnv1a(id)) >>> 0);
    out[id] = { question, options: order.map((i) => keys[i]!), labels: labelsFor(keys.length) };
  }
  return out;
}

/** Converts a label distribution into probabilities in canonical option order, or null if empty. */
export function toOptionProbs(item: BatchQuestion, dist: LabelDistribution | undefined, keys: string[]): number[] | null {
  if (!dist) return null;
  const byOption = new Map<string, number>();
  let total = 0;
  item.labels.forEach((label, j) => {
    const v = dist[label];
    const x = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    byOption.set(item.options[j]!, x);
    total += x;
  });
  if (total <= 0) return null;
  return normalize(keys.map((k) => byOption.get(k) ?? 0));
}

/**
 * Answers every question about one state. One backend call per option
 * permutation (run in parallel); results are averaged across permutations to
 * cancel position bias, then calibrated and banded.
 */
export async function decide(
  state: State,
  questions: Record<string, Question>,
  backend: Backend,
  opts: DecideOptions = {},
): Promise<DecideResult> {
  const ids = Object.keys(questions);
  for (const id of ids) validateQuestion(id, questions[id]!);
  const stateHash = hashState(state);
  const started = performance.now();
  if (ids.length === 0) return { stateHash, answers: {}, records: [], calls: 0, latencyMs: 0 };

  const nPerm = Math.max(1, Math.floor(opts.permutations ?? DEFAULT_PERMUTATIONS));
  const seed = opts.seed ?? fnv1a(stateHash);
  const batches = Array.from({ length: nPerm }, (_, p) => batchForPermutation(questions, p, seed));
  const callOpts = opts.signal ? { signal: opts.signal } : undefined;

  // One call per permutation when batching; otherwise one per question per permutation.
  const jobs: Array<{ p: number; batch: Record<string, BatchQuestion> }> = [];
  for (let p = 0; p < nPerm; p++) {
    if (backend.capabilities.batch) jobs.push({ p, batch: batches[p]! });
    else for (const id of ids) jobs.push({ p, batch: { [id]: batches[p]![id]! } });
  }
  const settled = await Promise.allSettled(jobs.map((j) => backend.answerBatch(state, j.batch, callOpts)));
  const latencyMs = Math.round(performance.now() - started);

  const perQuestion = new Map<string, number[][]>(ids.map((id) => [id, []]));
  let firstError: unknown;
  settled.forEach((res, i) => {
    if (res.status === 'rejected') {
      firstError ??= res.reason;
      return;
    }
    const { batch } = jobs[i]!;
    for (const id of Object.keys(batch)) {
      const probs = toOptionProbs(batch[id]!, res.value[id], optionKeys(questions[id]!));
      if (probs) perQuestion.get(id)!.push(probs);
    }
  });

  const ts = new Date().toISOString();
  const answers: DecideResult['answers'] = {};
  const records: DecisionRecord[] = [];
  for (const id of ids) {
    const question = questions[id]!;
    const samples = perQuestion.get(id)!;
    if (samples.length === 0) {
      const why = firstError instanceof Error ? `: ${firstError.message}` : '';
      throw new Error(`backend ${backend.name} returned no answer for question "${id}"${why}`, { cause: firstError });
    }
    const keys = optionKeys(question);
    const raw = keys.map((_, k) => samples.reduce((acc, s) => acc + s[k]!, 0) / samples.length);
    const calibrator = opts.calibrators?.[id];
    const calibrated = applyCalibrator(raw, calibrator);
    const answer = buildAnswer(question, calibrated, resolveBands(question, opts.bands));
    answers[id] = answer;
    const record: DecisionRecord = {
      ts,
      stateHash,
      questionId: id,
      question,
      backend: backend.name,
      raw: toRecord(keys, raw),
      calibrated: toRecord(keys, calibrated),
      answer,
      permutations: samples.length,
      latencyMs,
    };
    if (backend.model !== undefined) record.model = backend.model;
    if (calibrator) record.calibrator = calibrator;
    records.push(record);
  }
  return { stateHash, answers, records, calls: jobs.length, latencyMs };
}
