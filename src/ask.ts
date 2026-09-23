import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { appendNoFollow, ensureStoreDirSync } from './util/safefs.js';
import { createBackend } from './backends/index.js';
import { winningOption } from './engine/answer.js';
import { decide } from './engine/decide.js';
import { calibratorsForQuestion, validateQuestion } from './engine/questions.js';
import {
  DEFAULT_BUDGET,
  RELEVANCE_BATCH,
  RELEVANCE_PREFIX,
  occlude,
  optionProbability,
  pYesByPrefix,
  relevanceQuestions,
  type OcclusionOptions,
} from './explain/occlusion.js';
import { DEFAULT_REASONS, REASON_PREFIX, collectReasons, reasonQuestions, type ReasonSpec } from './explain/reasons.js';
import { buildSummary } from './explain/summary.js';
import { explainWhy, shouldExplainWhy } from './explain/why.js';
import { assembleGraph } from './graph/index.js';
import { SECRET_FILE, buildScope, chunkDiff, renderState, type AskScope, type Chunk } from './scope.js';
import type {
  Answer,
  Backend,
  DecideOptions,
  DecisionRecord,
  ExplainBlock,
  ExplainStats,
  Question,
  QuestionType,
  ReasonCode,
} from './types.js';
import { sha256 } from './util/hash.js';

// Same directory as the graph store; kept local so ask never loads node:sqlite.
export const STORE_DIR = '.glassbox';
export const DECISION_LOG = 'decisions.jsonl';
const QID = 'q';

export type AskExplainOptions = Omit<OcclusionOptions, 'relevance' | 'baseline' | 'decide'>;

export interface AskOptions {
  /** Default: createBackend() (the host agent's CLI via GLASSBOX_BACKEND=auto). */
  backend?: Backend;
  /** Repo root that paths are relative to and the log lives under. Default cwd. */
  root?: string;
  /** Hide-and-re-ask evidence, reasons and summary. true, or budget options. */
  explain?: boolean | AskExplainOptions;
  /** true: always generate the one-line why; false: never; unset: only when band != act. */
  why?: boolean;
  /** Reason codes checked when explaining. Default DEFAULT_REASONS. */
  reasons?: readonly ReasonSpec[];
  decide?: DecideOptions;
  /** Longest chunk in lines. Default 8. */
  chunkLines?: number;
  /** Refuse larger states. Default 60000 characters. */
  maxChars?: number;
  /** false: no log; a string: log file path. Default <root>/.glassbox/decisions.jsonl. */
  log?: boolean | string;
  signal?: AbortSignal;
}

export interface AskResult {
  question: Question;
  answer: Answer;
  /** The logged record, with `explain` attached when there is one. */
  record: DecisionRecord;
  explain?: ExplainBlock;
  explainStats?: ExplainStats;
  chunks: Chunk[];
  /** Backend calls: the decision, explanation, and the why. */
  calls: { decide: number; explain: number; why: number };
  latencyMs: number;
  backend: string;
  model?: string;
  /** The model and where it came from, e.g. "opus[1m] from ~/.claude/settings.json". */
  modelSource?: string;
  /** Model runs per call (processes started for each call). */
  samples?: number;
  logFile?: string;
}

/**
 * Builds a question from CLI-style input. choice options are "key" or
 * "key=description"; score options are the levels, lowest first.
 */
export function makeQuestion(text: string, type: QuestionType = 'yesno', options: readonly string[] = []): Question {
  const instructions = text.trim();
  switch (type) {
    case 'yesno':
      return { type, instructions };
    case 'choice': {
      const criteria: Record<string, string> = {};
      for (const o of options) {
        const eq = o.indexOf('=');
        const key = (eq > 0 ? o.slice(0, eq) : o).trim();
        if (key) criteria[key] = eq > 0 ? o.slice(eq + 1).trim() : '';
      }
      return { type, instructions, criteria };
    }
    case 'score':
      return { type, instructions, criteria: options.length ? options.map((o) => o.trim()) : ['none', 'low', 'medium', 'high'] };
  }
}

/** Short stable id for a logged decision. */
export function decisionId(record: Pick<DecisionRecord, 'ts' | 'stateHash' | 'questionId' | 'question'>): string {
  return sha256(`${record.ts}\u0000${record.stateHash}\u0000${record.questionId}\u0000${record.question.instructions}`).slice(0, 12);
}

/** Reads the JSONL decision log; missing file means no records. Bad lines are skipped. */
export async function readDecisionLog(file: string): Promise<DecisionRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // A torn last line from a crash should not hide the rest.
    }
  }
  return out;
}

/** Appends one record to the JSONL decision log. */
export async function appendDecisionLog(file: string, record: DecisionRecord): Promise<void> {
  const dir = dirname(file);
  if (basename(dir) === STORE_DIR) ensureStoreDirSync(dirname(dir), STORE_DIR);
  else await mkdir(dir, { recursive: true });
  await appendNoFollow(file, `${JSON.stringify(record)}\n`);
}

/** Stands in for a secret-looking file name in a logged diff file list. */
export const SECRET_FILE_PLACEHOLDER = '<secret file omitted>';

/**
 * How a diff is logged: the files it touches and its sha256, never the text,
 * which may hold secrets. explain re-asks only when it is given a diff with
 * the same hash (for example the unchanged working tree).
 */
export function logDiff(diff: string): { diffFiles: string[]; diffHash: string } {
  const files = new Set<string>();
  // Even the names of secret-looking files (.env.production, deploy.pem) stay out of the log.
  const safe = (f: string) => (SECRET_FILE.test(f) ? SECRET_FILE_PLACEHOLDER : f);
  for (const c of chunkDiff(diff)) {
    files.add(safe(c.file));
    if (c.renamedFrom !== undefined) files.add(safe(c.renamedFrom));
  }
  return { diffFiles: [...files].sort(), diffHash: sha256(diff) };
}

/** The scope as stored in the log (only the parts that were given). */
function logScope(scope: AskScope): NonNullable<DecisionRecord['scope']> {
  const out: NonNullable<DecisionRecord['scope']> = {};
  if (scope.paths?.length) out.paths = [...scope.paths];
  if (scope.diff !== undefined) Object.assign(out, logDiff(scope.diff));
  if (scope.nodes?.length) out.nodes = [...scope.nodes];
  return out;
}

/**
 * Answers one typed question about code. The scope (files, a diff or node ids)
 * becomes chunks under file:line headers; the decision is one batched call per
 * option order. With `explain`, reasons and the relevance prefilter are asked
 * as hidden yes/no questions in one batch that runs in parallel with the
 * decision, so explaining never changes or delays the answer itself.
 */
export async function ask(scope: AskScope, question: string | Question, opts: AskOptions = {}): Promise<AskResult> {
  const started = performance.now();
  const q: Question = typeof question === 'string' ? makeQuestion(question) : question;
  validateQuestion(QID, q);
  const backend = opts.backend ?? createBackend();
  const root = opts.root ?? process.cwd();
  const { chunks, extracts } = await buildScope(scope, {
    root,
    ...(opts.chunkLines !== undefined ? { maxLines: opts.chunkLines } : {}),
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
  });
  const state = renderState(chunks);
  const calibrators = calibratorsForQuestion(opts.decide?.calibrators, QID, q, 'ask');
  const decideOpts: DecideOptions = {
    ...opts.decide,
    ...(calibrators ? { calibrators } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const explainOpts: AskExplainOptions | undefined = opts.explain === true ? {} : opts.explain || undefined;

  // Hidden questions: reason codes, plus per-chunk relevance when it fits one batch.
  const reasons = explainOpts ? [...(opts.reasons ?? DEFAULT_REASONS)] : [];
  const withRelevance = Boolean(explainOpts) && backend.capabilities.batch && chunks.length <= RELEVANCE_BATCH;
  const hidden = {
    ...reasonQuestions(reasons, q.instructions),
    ...(withRelevance ? relevanceQuestions(chunks, q.instructions) : {}),
  };
  const [main, side] = await Promise.all([
    decide(state, { [QID]: q }, backend, decideOpts),
    Object.keys(hidden).length > 0 ? decide(state, hidden, backend, decideOpts).catch(() => undefined) : undefined,
  ]);
  const answer = main.answers[QID]!;
  let explainCalls = side?.calls ?? 0;

  let explain: ExplainBlock | undefined;
  let explainStats: ExplainStats | undefined;
  if (explainOpts) {
    const option = winningOption(answer);
    const occ = await occlude(chunks, q, option, backend, {
      ...explainOpts,
      // The hidden batch already spent part of the explain budget.
      budget: Math.max(0, (explainOpts.budget ?? DEFAULT_BUDGET) - explainCalls),
      baseline: optionProbability(answer, option),
      ...(side && withRelevance ? { relevance: pYesByPrefix(side.answers, RELEVANCE_PREFIX) } : {}),
      decide: decideOpts,
    });
    explainCalls += occ.calls;
    const reasonCodes: ReasonCode[] = side ? collectReasons(reasons, pYesByPrefix(side.answers, REASON_PREFIX)) : [];
    explainStats = { calls: explainCalls, candidates: occ.candidates.length, tested: occ.trials.length, baselineP: occ.baselineP };
    explain = { highlights: occ.highlights, reasons: reasonCodes, summary: [], stats: explainStats };
  }

  let whyCalls = 0;
  if (shouldExplainWhy(answer, opts.why) && backend.capabilities.generate && backend.generate) {
    whyCalls = 1;
    const res = await explainWhy(backend, {
      question: q,
      answer,
      chunks,
      highlights: explain?.highlights ?? [],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res) {
      explain ??= { highlights: [], reasons: [], summary: [] };
      explain.highlights.forEach((h, i) => {
        const c = res.comments[i];
        if (c) h.comment = c;
      });
      if (res.why) explain.why = res.why;
    }
  }

  if (explain && explainOpts) {
    const graph = assembleGraph(extracts);
    explain.summary = buildSummary({
      highlights: explain.highlights,
      reasons: explain.reasons,
      chunks,
      nodes: graph.nodes,
      edges: graph.edges,
    });
  }

  const record: DecisionRecord = { ...main.records[0]!, ...(explain ? { explain } : {}) };
  let logFile: string | undefined;
  if (opts.log !== false) {
    record.id = decisionId(record);
    record.scope = logScope(scope);
    logFile = typeof opts.log === 'string' ? opts.log : join(root, STORE_DIR, DECISION_LOG);
    await appendDecisionLog(logFile, record);
  }

  const result: AskResult = {
    question: q,
    answer,
    record,
    chunks,
    calls: { decide: main.calls, explain: explainCalls, why: whyCalls },
    latencyMs: Math.round(performance.now() - started),
    backend: backend.name,
    ...(backend.samples && backend.samples > 1 ? { samples: backend.samples } : {}),
  };
  if (explain) result.explain = explain;
  if (explainStats) result.explainStats = explainStats;
  if (backend.model !== undefined) result.model = backend.model;
  if (backend.modelSource !== undefined) result.modelSource = backend.modelSource;
  if (logFile) result.logFile = logFile;
  return result;
}
