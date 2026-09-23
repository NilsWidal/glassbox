import { join } from 'node:path';
import { appendDecisionLog, decisionId, makeQuestion, DECISION_LOG, STORE_DIR } from '../ask.js';
import { decide as decideEngine } from '../engine/decide.js';
import { calibratorsForQuestion } from '../engine/questions.js';
import { SourceCache } from '../memory/source.js';
import type { GraphStore } from '../memory/store.js';
import { nodeTagLabels } from '../memory/tags.js';
import { spanLabel } from '../scope.js';
import type { Backend, Band, ChoiceAnswer, ChoiceQuestion, DecideOptions, DecisionRecord } from '../types.js';
import { lexicalScore, queryTerms } from './lexical.js';
import { whereCandidates } from './where.js';

export const DEFAULT_CONTEXT_NODES = 6;
/** Nodes whose source is shown, not just their tags. */
const SOURCE_NODES = 3;
const SOURCE_LINES = 20;
const QID = 'q';

export interface DecideQueryOptions {
  backend: Backend;
  root: string;
  /** Graph store for context. Without it the answer uses the hint alone. */
  store?: GraphStore;
  /** Most graph nodes put in context. Default 6. */
  contextNodes?: number;
  decide?: DecideOptions;
  /** false: no log; a string: log file. Default <root>/.glassbox/decisions.jsonl. */
  log?: boolean | string;
}

export interface DecideQueryResult {
  question: ChoiceQuestion;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  band: Band;
  answer: ChoiceAnswer;
  /** Always true: glassbox advises, the agent or the user decides. */
  advisory: true;
  /** Graph nodes given as context. */
  context: string[];
  record: DecisionRecord;
  calls: number;
  latencyMs: number;
  backend: string;
  model?: string;
  /** Model runs per call (processes started for each call). */
  samples?: number;
  logFile?: string;
}

/** The state: the hint, then related nodes with their stored tags and a short source excerpt. */
async function buildContext(
  question: string,
  options: readonly string[],
  hint: string | undefined,
  opts: DecideQueryOptions,
): Promise<{ state: string; nodes: string[] }> {
  const parts: string[] = [];
  if (hint?.trim()) parts.push('## Context from the agent', hint.trim());
  const nodes: string[] = [];
  if (opts.store) {
    const terms = queryTerms([question, ...options, hint ?? ''].join(' '));
    const src = new SourceCache(opts.root);
    const scored = whereCandidates(opts.store.getNodes())
      .map((node) => ({ node, s: lexicalScore(terms, { node, tags: opts.store!.getTags(node.id) }) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (a.node.id < b.node.id ? -1 : 1))
      .slice(0, Math.max(0, opts.contextNodes ?? DEFAULT_CONTEXT_NODES));
    if (scored.length) parts.push('## Related code (from the glassbox graph)');
    for (const [i, { node }] of scored.entries()) {
      nodes.push(node.id);
      const tags = nodeTagLabels(opts.store, node.id);
      parts.push(`### ${spanLabel(node.file, node.startLine, node.endLine)} (${node.kind} ${node.name})`);
      if (tags.length) parts.push(`tags: ${tags.join(', ')}`);
      if (i < SOURCE_NODES) {
        const text = await src.text(node, SOURCE_LINES);
        if (text) parts.push(text);
      }
    }
  }
  if (parts.length === 0) parts.push('(no extra context)');
  return { state: parts.join('\n'), nodes };
}

/**
 * Answers the agent's own "A or B?" question with probabilities, using the
 * code graph's tags as context. It only advises: nothing is changed and the
 * caller stays responsible for the choice. Options are "key" or "key=description".
 */
export async function decide(
  question: string,
  options: readonly string[],
  contextHint: string | undefined,
  opts: DecideQueryOptions,
): Promise<DecideQueryResult> {
  const started = performance.now();
  const q = makeQuestion(question, 'choice', options) as ChoiceQuestion;
  if (Object.keys(q.criteria).length < 2) throw new Error('decide needs at least 2 options');
  const optionText = Object.entries(q.criteria).map(([k, v]) => (v ? `${k} ${v}` : k));
  const { state, nodes } = await buildContext(question, optionText, contextHint, opts);
  const calibrators = calibratorsForQuestion(opts.decide?.calibrators, QID, q, 'decide');
  const res = await decideEngine(state, { [QID]: q }, opts.backend, calibrators ? { ...opts.decide, calibrators } : opts.decide);
  const answer = res.answers[QID] as ChoiceAnswer;

  const record: DecisionRecord = { ...res.records[0]!, source: 'decide' };
  let logFile: string | undefined;
  if (opts.log !== false) {
    record.id = decisionId(record);
    if (nodes.length) record.scope = { nodes };
    logFile = typeof opts.log === 'string' ? opts.log : join(opts.root, STORE_DIR, DECISION_LOG);
    await appendDecisionLog(logFile, record);
  }
  const result: DecideQueryResult = {
    question: q,
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    band: answer.band,
    answer,
    advisory: true,
    context: nodes,
    record,
    calls: res.calls,
    latencyMs: Math.round(performance.now() - started),
    backend: opts.backend.name,
    ...(opts.backend.samples && opts.backend.samples > 1 ? { samples: opts.backend.samples } : {}),
  };
  if (opts.backend.model !== undefined) result.model = opts.backend.model;
  if (logFile) result.logFile = logFile;
  return result;
}
