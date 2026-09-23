import { mapLimit } from '../backends/sampling.js';
import { decide, DEFAULT_PERMUTATIONS } from '../engine/decide.js';
import { chunkHeader, renderState, type Chunk } from '../scope.js';
import type { Answer, Backend, DecideOptions, Highlight, Question, YesNoQuestion } from '../types.js';

export const DEFAULT_BUDGET = 24;
export const DEFAULT_TOP_K = 12;
export const DEFAULT_MIN_DELTA = 0.05;
export const DEFAULT_MAX_HIGHLIGHTS = 5;
export const RELEVANCE_PREFIX = 'rel:';
/** Relevance questions per batch; more chunks than this take extra calls. */
export const RELEVANCE_BATCH = 40;

export interface OcclusionOptions {
  /** Cap on backend calls spent here, baseline and prefilter included. Default 24. */
  budget?: number;
  /** Only the K most relevant chunks are hidden and re-asked. Default 12. */
  topK?: number;
  /** Keep highlights with |deltaP| at least this. Default 0.05. */
  minDelta?: number;
  maxHighlights?: number;
  /** Re-asks in flight at once. Default 4. */
  concurrency?: number;
  /** Chunk id -> P(relevant), when already asked (for example in the reasons batch). */
  relevance?: Readonly<Record<string, number>>;
  /** P(option) on the full state, when already known from the main answer. */
  baseline?: number;
  /** Passed to every re-ask (permutations, calibrators, bands). */
  decide?: DecideOptions;
  /**
   * Builds the state with some chunks hidden. Default renderState (### headers).
   * Callers whose state has another layout (decide's hint, tags and excerpts)
   * pass their own, so evidence is measured on the input the answer came from.
   */
  render?: (hidden: ReadonlySet<string>) => string;
}

export interface OcclusionTrial {
  chunkId: string;
  /** P(option) with the chunk hidden. */
  p: number;
  /** p(hidden) - p(full): negative means the chunk supported the answer. */
  deltaP: number;
}

export interface OcclusionResult {
  highlights: Highlight[];
  trials: OcclusionTrial[];
  /** Chunk ids chosen by the prefilter, most relevant first. */
  candidates: string[];
  /** Candidates left untested because the budget ran out, or whose re-ask failed. */
  untested: string[];
  baselineP: number;
  /** Backend calls made here. */
  calls: number;
}

/** P(option) from an answer. For score answers the option is a level index. */
export function optionProbability(answer: Answer, option: string): number {
  switch (answer.type) {
    case 'yesno':
      return option === 'true' ? answer.p : 1 - answer.p;
    case 'choice':
    case 'score':
      return answer.probabilities[option] ?? 0;
  }
}

/** Hidden yes/no prefilter questions, keyed `rel:<chunkId>`: is this chunk relevant to the question? */
export function relevanceQuestions(chunks: readonly Chunk[], mainQuestion: string): Record<string, YesNoQuestion> {
  const out: Record<string, YesNoQuestion> = {};
  for (const c of chunks) {
    out[`${RELEVANCE_PREFIX}${c.id}`] = {
      type: 'yesno',
      instructions: `Is the code under the header "${chunkHeader(c)}" relevant to answering: "${mainQuestion.trim()}"?`,
    };
  }
  return out;
}

/** Picks P(yes) of `prefix`-keyed questions out of decide answers. */
export function pYesByPrefix(answers: Readonly<Record<string, Answer>>, prefix: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, a] of Object.entries(answers)) {
    if (id.startsWith(prefix) && a.type === 'yesno') out[id.slice(prefix.length)] = a.p;
  }
  return out;
}

/**
 * Evidence by hiding and re-asking. Each candidate chunk is removed from the
 * state and the question re-asked; deltaP = p(hidden) - p(full) for the
 * chosen option. Only the top-K chunks by the model's own relevance rating
 * are tried, and never more calls than the budget allows.
 */
export async function occlude(
  chunks: readonly Chunk[],
  question: Question,
  option: string,
  backend: Backend,
  opts: OcclusionOptions = {},
): Promise<OcclusionResult> {
  const budget = Math.max(0, Math.floor(opts.budget ?? DEFAULT_BUDGET));
  const perAsk = Math.max(1, Math.floor(opts.decide?.permutations ?? DEFAULT_PERMUTATIONS));
  const decideOpts = { ...opts.decide, permutations: perAsk };
  const qid = 'q';
  let calls = 0;
  const render = opts.render ?? ((hidden: ReadonlySet<string>) => renderState(chunks, hidden));

  const ask = async (state: string): Promise<number> => {
    const res = await decide(state, { [qid]: question }, backend, decideOpts);
    calls += res.calls;
    return optionProbability(res.answers[qid]!, option);
  };

  let baselineP = opts.baseline;
  if (baselineP === undefined && calls + perAsk <= budget) baselineP = await ask(render(new Set()));

  // Prefilter: the model's own per-chunk relevance, asked in batches when not supplied.
  let relevance = opts.relevance;
  if (!relevance) {
    const asked: Record<string, number> = {};
    const qs = relevanceQuestions(chunks, question.instructions);
    const ids = Object.keys(qs);
    const state = render(new Set());
    for (let i = 0; i < ids.length; i += RELEVANCE_BATCH) {
      const cost = backend.capabilities.batch ? perAsk : perAsk * Math.min(RELEVANCE_BATCH, ids.length - i);
      if (calls + cost > budget) break;
      const part = Object.fromEntries(ids.slice(i, i + RELEVANCE_BATCH).map((id) => [id, qs[id]!]));
      const res = await decide(state, part, backend, decideOpts);
      calls += res.calls;
      Object.assign(asked, pYesByPrefix(res.answers, RELEVANCE_PREFIX));
    }
    relevance = asked;
  }

  // Stable ranking: relevance desc, then document order; unrated chunks last.
  const ranked = chunks
    .map((c, i) => ({ c, i, r: relevance[c.id] ?? -1 }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.c);
  const topK = Math.max(0, Math.floor(opts.topK ?? DEFAULT_TOP_K));
  const candidates = ranked.slice(0, topK);

  if (baselineP === undefined) {
    return { highlights: [], trials: [], candidates: candidates.map((c) => c.id), untested: candidates.map((c) => c.id), baselineP: NaN, calls };
  }
  const full = baselineP;
  const affordable = Math.max(0, Math.floor((budget - calls) / perAsk));
  const tried = candidates.slice(0, affordable);

  const results = await mapLimit(tried, Math.max(1, opts.concurrency ?? 4), async (c) => {
    try {
      const p = await ask(render(new Set([c.id])));
      return { chunkId: c.id, p, deltaP: round(p - full) };
    } catch {
      return undefined;
    }
  });
  const trials = results.filter((t): t is OcclusionTrial => t !== undefined);
  const done = new Set(trials.map((t) => t.chunkId));

  const minDelta = opts.minDelta ?? DEFAULT_MIN_DELTA;
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const highlights = trials
    .filter((t) => Math.abs(t.deltaP) >= minDelta)
    .sort((a, b) => Math.abs(b.deltaP) - Math.abs(a.deltaP))
    .slice(0, opts.maxHighlights ?? DEFAULT_MAX_HIGHLIGHTS)
    .map((t): Highlight => {
      const c = byId.get(t.chunkId)!;
      return { file: c.file, startLine: c.startLine, endLine: c.endLine, deltaP: t.deltaP, kind: 'causal' };
    });

  return {
    highlights,
    trials,
    candidates: candidates.map((c) => c.id),
    untested: candidates.filter((c) => !done.has(c.id)).map((c) => c.id),
    baselineP: full,
    calls,
  };
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
