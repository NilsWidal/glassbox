import { appendDecisionLog, decisionId, logDiff, DECISION_LOG, STORE_DIR } from '../ask.js';
import { winningOption } from '../engine/answer.js';
import { decide } from '../engine/decide.js';
import { occlude, optionProbability, pYesByPrefix } from '../explain/occlusion.js';
import { DEFAULT_REASONS, REASON_PREFIX, collectReasons, reasonQuestions, type ReasonSpec } from '../explain/reasons.js';
import { buildSummary } from '../explain/summary.js';
import type { GraphStore, StoredNode } from '../memory/store.js';
import { RISK_LEVELS, nodeTagLabels } from '../memory/tags.js';
import { chunkDiff, chunkHeader, nodeAt, renderState, safeDiffChunks, type Chunk } from '../scope.js';
import type {
  Backend,
  DecideOptions,
  DecisionRecord,
  EdgeKind,
  ExplainBlock,
  ReasonCode,
  ScoreAnswer,
  ScoreQuestion,
} from '../types.js';
import { join } from 'node:path';

export const DEFAULT_TRIAGE_BUDGET = 12;
const HUNK_PREFIX = 'hunk:';
const OVERALL = 'risk';
const MAX_CONTEXT_NODES = 8;

export interface TriageOptions {
  store: GraphStore;
  root: string;
  backend: Backend;
  /** Hide-and-re-ask evidence on the overall risk. false skips it. Default budget 12 calls. */
  explain?: boolean | { budget?: number; topK?: number; minDelta?: number };
  /** Reason codes asked alongside when explaining. Default DEFAULT_REASONS. */
  reasons?: readonly ReasonSpec[];
  decide?: DecideOptions;
  /** Longest hunk window in diff lines. Default 8. */
  chunkLines?: number;
  /** false: no log; a string: log file. Default <root>/.glassbox/decisions.jsonl. */
  log?: boolean | string;
}

export interface HunkRisk {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Innermost graph nodes the hunk touches (the file node when outside any function). */
  nodes: string[];
  level: string;
  /** Expected level, 0 (Low) to 2 (High). */
  score: number;
  /** P(level). */
  p: number;
  answer: ScoreAnswer;
}

export interface AffectedNode {
  nodeId: string;
  file: string;
  line: number;
  name: string;
  /** The touched node this one depends on. */
  via: string;
  edge: EdgeKind;
}

export interface TriageResult {
  overall: ScoreAnswer;
  level: string;
  hunks: HunkRisk[];
  /** Direct callers and importers of the touched nodes (one hop). */
  affected: AffectedNode[];
  explain: ExplainBlock;
  record: DecisionRecord;
  calls: { decide: number; explain: number };
  latencyMs: number;
  backend: string;
  model?: string;
  /** Model runs per call (processes started for each call). */
  samples?: number;
  logFile?: string;
}

function riskQuestion(instructions: string): ScoreQuestion {
  return { type: 'score', instructions, criteria: [...RISK_LEVELS] };
}

/**
 * Innermost node per changed line of the hunk (context lines skipped); the file
 * node outside any function. A renamed or moved file also touches the file node
 * under its old path, which is what its importers still point at; a pure
 * rename touches only that file node.
 */
function touchedNodes(
  c: Pick<Chunk, 'file' | 'startLine' | 'endLine' | 'changedLines' | 'renamedFrom' | 'renameOnly'>,
  nodes: readonly StoredNode[],
): string[] {
  const out = new Set<string>();
  if (c.renamedFrom !== undefined) out.add(c.renamedFrom);
  if (c.renameOnly) return [...out];
  const lines = c.changedLines ?? Array.from({ length: c.endLine - c.startLine + 1 }, (_, i) => c.startLine + i);
  for (const line of lines) {
    const n = nodeAt(nodes, c.file, line);
    out.add(n ? n.id : c.file);
  }
  return [...out];
}

/** "verifySession (src/auth/session.ts:20): handles_auth=yes 0.93, risk=High 0.70". */
function contextLines(store: GraphStore, ids: readonly string[]): string[] {
  return ids.slice(0, MAX_CONTEXT_NODES).flatMap((id) => {
    const n = store.getNode(id);
    const tags = nodeTagLabels(store, id);
    if (!n || tags.length === 0) return [];
    return [`${n.name} (${n.file}:${n.startLine}): ${tags.join(', ')}`];
  });
}

/**
 * Scores the risk of a diff per hunk and overall, using stored tags of the
 * touched nodes as context, and lists their direct callers from the graph.
 * With explain (the default), the overall answer is backed by hide-and-re-ask
 * highlights on the hunks, reason codes and a pseudo-code summary.
 */
export async function triage(diff: string, opts: TriageOptions): Promise<TriageResult> {
  const started = performance.now();
  const { store, backend } = opts;
  const all = chunkDiff(diff, opts.chunkLines !== undefined ? { maxLines: opts.chunkLines } : {});
  // Secret-looking files (.env, keys) are never sent to the model.
  const raw = safeDiffChunks(all);
  if (raw.length === 0) {
    throw new Error(all.length ? 'the diff only touches files that may hold secrets, which are never sent' : 'the diff has no changed lines');
  }
  const nodes = store.getNodes();
  const chunks: Chunk[] = raw.map((c, i) => {
    const chunk: Chunk = { id: `h${i + 1}`, ...c };
    const inner = touchedNodes(c, nodes).find((id) => id !== c.file && id !== c.renamedFrom);
    if (inner) chunk.nodeId = inner;
    return chunk;
  });
  const touched = new Map(chunks.map((c) => [c.id, touchedNodes(c, nodes)]));
  const allTouched = [...new Set([...touched.values()].flat())];

  const ctx = contextLines(store, allTouched);
  const context = ctx.length ? `\nStored graph tags of the touched code:\n${ctx.map((l) => `- ${l}`).join('\n')}` : '';
  const overallQ = riskQuestion(
    `How risky is this change overall? High means it could cause security, data loss, money or privacy problems, or break callers.${context}`,
  );
  const questions: Record<string, ScoreQuestion> = { [OVERALL]: overallQ };
  for (const c of chunks) {
    const names = touched
      .get(c.id)!
      .map((id) => store.getNode(id)?.name ?? id)
      .join(', ');
    questions[`${HUNK_PREFIX}${c.id}`] = riskQuestion(
      `How risky is the change under the header "${chunkHeader(c)}" (touches ${names})? Judge that hunk only.`,
    );
  }

  const state = renderState(chunks);
  const decideOpts: DecideOptions = { ...opts.decide };
  const explainOpts = opts.explain === false ? undefined : opts.explain === true || opts.explain === undefined ? {} : opts.explain;
  const reasons = explainOpts ? [...(opts.reasons ?? DEFAULT_REASONS)] : [];
  const [main, side] = await Promise.all([
    decide(state, questions, backend, decideOpts),
    reasons.length
      ? decide(state, reasonQuestions(reasons, overallQ.instructions), backend, decideOpts).catch(() => undefined)
      : undefined,
  ]);
  const overall = main.answers[OVERALL] as ScoreAnswer;
  const level = (a: ScoreAnswer) => winningOption(a);

  const hunks: HunkRisk[] = chunks.map((c) => {
    const a = main.answers[`${HUNK_PREFIX}${c.id}`] as ScoreAnswer;
    const lv = level(a);
    return {
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      nodes: touched.get(c.id)!,
      level: RISK_LEVELS[Number(lv)] ?? lv,
      score: a.score,
      p: optionProbability(a, lv),
      answer: a,
    };
  });

  // One hop: who calls or imports what the diff touched.
  const touchedSet = new Set(allTouched);
  const affected = new Map<string, AffectedNode>();
  for (const id of allTouched) {
    for (const kind of ['calls', 'imports'] as const) {
      for (const e of store.edgesTo(id, kind)) {
        if (touchedSet.has(e.from) || affected.has(e.from) || e.from === id) continue;
        const n = store.getNode(e.from);
        if (n) affected.set(e.from, { nodeId: n.id, file: n.file, line: n.startLine, name: n.name, via: id, edge: kind });
      }
    }
  }

  let explainCalls = side?.calls ?? 0;
  const explain: ExplainBlock = { highlights: [], reasons: [], summary: [] };
  if (explainOpts) {
    const option = level(overall);
    const budget = explainOpts.budget ?? DEFAULT_TRIAGE_BUDGET;
    // The per-hunk risk doubles as the relevance prefilter, so the riskiest hunks are hidden first.
    const relevance = Object.fromEntries(hunks.map((h) => [h.id, h.score / (RISK_LEVELS.length - 1)]));
    const occ = await occlude(chunks, overallQ, option, backend, {
      budget: Math.max(0, budget - explainCalls),
      ...(explainOpts.topK !== undefined ? { topK: explainOpts.topK } : {}),
      ...(explainOpts.minDelta !== undefined ? { minDelta: explainOpts.minDelta } : {}),
      baseline: optionProbability(overall, option),
      relevance,
      decide: decideOpts,
    });
    explainCalls += occ.calls;
    const reasonCodes: ReasonCode[] = side ? collectReasons(reasons, pYesByPrefix(side.answers, REASON_PREFIX)) : [];
    explain.highlights = occ.highlights;
    explain.reasons = reasonCodes;
    explain.stats = { calls: explainCalls, candidates: occ.candidates.length, tested: occ.trials.length, baselineP: occ.baselineP };
    explain.summary = buildSummary({
      highlights: occ.highlights,
      reasons: reasonCodes,
      chunks,
      nodes,
      edges: store.getEdges('calls'),
    });
  }

  const base = main.records.find((r) => r.questionId === OVERALL)!;
  const record: DecisionRecord = { ...base, source: 'triage', explain };
  let logFile: string | undefined;
  if (opts.log !== false) {
    record.id = decisionId(record);
    record.scope = logDiff(diff);
    logFile = typeof opts.log === 'string' ? opts.log : join(opts.root, STORE_DIR, DECISION_LOG);
    await appendDecisionLog(logFile, record);
  }

  const result: TriageResult = {
    overall,
    level: RISK_LEVELS[Number(level(overall))] ?? level(overall),
    hunks,
    affected: [...affected.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)),
    explain,
    record,
    calls: { decide: main.calls, explain: explainCalls },
    latencyMs: Math.round(performance.now() - started),
    backend: backend.name,
    ...(backend.samples && backend.samples > 1 ? { samples: backend.samples } : {}),
  };
  if (backend.model !== undefined) result.model = backend.model;
  if (logFile) result.logFile = logFile;
  return result;
}
