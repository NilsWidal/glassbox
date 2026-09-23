import { join } from 'node:path';
import { appendDecisionLog, decisionId, makeQuestion, DECISION_LOG, STORE_DIR } from '../ask.js';
import { decide as decideEngine } from '../engine/decide.js';
import { calibratorsForQuestion } from '../engine/questions.js';
import { SourceCache } from '../memory/source.js';
import type { GraphStore } from '../memory/store.js';
import { nodeTagLabels } from '../memory/tags.js';
import { spanLabel, type Chunk } from '../scope.js';
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
  /** The model and where it came from, e.g. "opus[1m] from ~/.claude/settings.json". */
  modelSource?: string;
  /** Model runs per call (processes started for each call). */
  samples?: number;
  logFile?: string;
}

/** Nodes related to the question, best first (lexical match on names, files and tags). */
function relatedNodes(question: string, options: readonly string[], hint: string | undefined, store: GraphStore, limit: number): string[] {
  const terms = queryTerms([question, ...options, hint ?? ''].join(' '));
  return whereCandidates(store.getNodes())
    .map((node) => ({ node, s: lexicalScore(terms, { node, tags: store.getTags(node.id) }) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.node.id < b.node.id ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map((x) => x.node.id);
}

/** One hideable part of decide's state: the agent's hint, or one related node's section. */
export interface DecideSegment {
  /** For occlusion and highlights: the hint is `(agent context)`, a node its own file and lines. */
  chunk: Chunk;
  /** The segment exactly as it appears in the state. */
  text: string;
}

const HINT_HEADER = '## Context from the agent';
const RELATED_HEADER = '## Related code (from the glassbox graph)';
export const HINT_FILE = '(agent context)';

/**
 * The parts of the state decide asks over: the hint, then the given nodes with
 * their stored tags and a short source excerpt.
 */
export async function decideSegments(
  hint: string | undefined,
  nodeIds: readonly string[],
  opts: { root: string; store?: GraphStore },
): Promise<DecideSegment[]> {
  const out: DecideSegment[] = [];
  const h = hint?.trim();
  if (h) {
    out.push({
      chunk: { id: 'hint', file: HINT_FILE, startLine: 1, endLine: h.split('\n').length, text: h },
      text: `${HINT_HEADER}\n${h}`,
    });
  }
  const store = opts.store;
  if (!store) return out;
  const src = new SourceCache(opts.root);
  for (const [i, id] of nodeIds.entries()) {
    const node = store.getNode(id);
    if (!node) {
      // A node that no longer exists: the rebuilt state differs, as it should.
      const text = `### ${id} (missing)`;
      out.push({ chunk: { id: `n${i + 1}`, file: id.split('#')[0]!, startLine: 1, endLine: 1, text }, text });
      continue;
    }
    const lines = [`### ${spanLabel(node.file, node.startLine, node.endLine)} (${node.kind} ${node.name})`];
    const tags = nodeTagLabels(store, node.id);
    if (tags.length) lines.push(`tags: ${tags.join(', ')}`);
    if (i < SOURCE_NODES) {
      const text = await src.text(node, SOURCE_LINES);
      if (text) lines.push(text);
    }
    const text = lines.join('\n');
    out.push({
      chunk: { id: `n${i + 1}`, file: node.file, startLine: node.startLine, endLine: node.endLine, text, nodeId: node.id },
      text,
    });
  }
  return out;
}

/** The state text from segments, leaving out hidden ones (by chunk id). */
export function renderDecideState(segments: readonly DecideSegment[], hidden?: ReadonlySet<string>): string {
  const parts: string[] = [];
  let related = false;
  for (const seg of segments) {
    if (hidden?.has(seg.chunk.id)) continue;
    if (seg.chunk.id !== 'hint' && !related) {
      parts.push(RELATED_HEADER);
      related = true;
    }
    parts.push(seg.text);
  }
  return parts.length ? parts.join('\n') : '(no extra context)';
}

/** The full state decide asks over (see decideSegments). */
export async function decideState(
  hint: string | undefined,
  nodeIds: readonly string[],
  opts: { root: string; store?: GraphStore },
): Promise<string> {
  return renderDecideState(await decideSegments(hint, nodeIds, opts));
}

/** The state: the hint, then related nodes with their stored tags and a short source excerpt. */
async function buildContext(
  question: string,
  options: readonly string[],
  hint: string | undefined,
  opts: DecideQueryOptions,
): Promise<{ state: string; nodes: string[] }> {
  const nodes = opts.store ? relatedNodes(question, options, hint, opts.store, opts.contextNodes ?? DEFAULT_CONTEXT_NODES) : [];
  return { state: await decideState(hint, nodes, opts), nodes };
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
    // The hint is kept so explain can rebuild this exact state later.
    if (nodes.length || contextHint?.trim()) {
      record.scope = { ...(nodes.length ? { nodes } : {}), ...(contextHint?.trim() ? { context: contextHint } : {}) };
    }
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
  if (opts.backend.modelSource !== undefined) result.modelSource = opts.backend.modelSource;
  if (logFile) result.logFile = logFile;
  return result;
}
