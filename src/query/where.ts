import { decide } from '../engine/decide.js';
import { SourceCache } from '../memory/source.js';
import type { GraphStore, StoredNode } from '../memory/store.js';
import { isTagTarget } from '../memory/tags.js';
import { chunkHeader, renderState, type Chunk } from '../scope.js';
import type { Backend, DecideOptions, GraphNode, YesNoQuestion } from '../types.js';
import { lexicalScore, queryTerms } from './lexical.js';

export const DEFAULT_WHERE_CANDIDATES = 8;
export const DEFAULT_WHERE_TOP = 5;
const CANDIDATE_LINES = 40;
const PREFIX = 'where:';

export interface WhereOptions {
  store: GraphStore;
  root: string;
  backend: Backend;
  /** Candidates from the lexical and tag prefilter that the model checks. Default 8. */
  candidates?: number;
  /** Hits returned. Default 5. */
  top?: number;
  decide?: DecideOptions;
}

export interface WhereHit {
  nodeId: string;
  kind: GraphNode['kind'];
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  /** P(yes) for "does this code implement <concept>?". */
  p: number;
  /** Prefilter score (name, path, body and tag matches). */
  lexical: number;
}

export interface WhereResult {
  concept: string;
  hits: WhereHit[];
  /** Nodes that matched the prefilter at all. */
  matched: number;
  /** Nodes the model was asked about. */
  asked: number;
  calls: number;
  /** Model runs per call (processes started for each call). */
  samples?: number;
  latencyMs: number;
}

/** Nodes worth ranking: tag targets plus classes. */
export function whereCandidates(nodes: readonly StoredNode[]): StoredNode[] {
  return nodes.filter((n) => isTagTarget(n) || n.kind === 'class');
}

/**
 * Ranks nodes likely to implement a concept. A cheap prefilter (name, path
 * and body words plus stored tags) picks candidates, then one batched yes/no
 * question per candidate ("does this code implement <concept>?") orders them.
 */
export async function where(concept: string, opts: WhereOptions): Promise<WhereResult> {
  const started = performance.now();
  const terms = queryTerms(concept);
  if (terms.length === 0) throw new Error('the concept has no searchable words; describe it more specifically');
  const src = new SourceCache(opts.root);
  const scored = await Promise.all(
    whereCandidates(opts.store.getNodes()).map(async (node) => {
      const text = await src.text(node);
      return { node, lexical: lexicalScore(terms, { node, tags: opts.store.getTags(node.id), ...(text ? { text } : {}) }) };
    }),
  );
  const matched = scored.filter((s) => s.lexical > 0);
  // Highest score first; on ties the narrower node wins, then source order.
  matched.sort(
    (a, b) =>
      b.lexical - a.lexical ||
      a.node.endLine - a.node.startLine - (b.node.endLine - b.node.startLine) ||
      (a.node.file < b.node.file ? -1 : a.node.file > b.node.file ? 1 : a.node.startLine - b.node.startLine),
  );
  const picked = matched.slice(0, Math.max(1, opts.candidates ?? DEFAULT_WHERE_CANDIDATES));
  if (picked.length === 0) {
    return { concept, hits: [], matched: 0, asked: 0, calls: 0, latencyMs: Math.round(performance.now() - started) };
  }

  const chunks: Chunk[] = [];
  for (const [i, { node }] of picked.entries()) {
    const text = (await src.text(node, CANDIDATE_LINES)) ?? '';
    chunks.push({ id: `n${i + 1}`, file: node.file, startLine: node.startLine, endLine: node.endLine, text, nodeId: node.id });
  }
  const questions: Record<string, YesNoQuestion> = {};
  for (const c of chunks) {
    questions[`${PREFIX}${c.id}`] = {
      type: 'yesno',
      instructions: `Does the code under the header "${chunkHeader(c)}" implement ${concept.trim()}?`,
    };
  }
  const res = await decide(renderState(chunks), questions, opts.backend, opts.decide);

  const hits: WhereHit[] = picked.map(({ node, lexical }, i) => {
    const a = res.answers[`${PREFIX}n${i + 1}`];
    return {
      nodeId: node.id,
      kind: node.kind,
      name: node.name,
      file: node.file,
      startLine: node.startLine,
      endLine: node.endLine,
      p: a?.type === 'yesno' ? a.p : 0,
      lexical,
    };
  });
  hits.sort((a, b) => b.p - a.p || b.lexical - a.lexical);
  return {
    concept,
    hits: hits.slice(0, Math.max(1, opts.top ?? DEFAULT_WHERE_TOP)),
    matched: matched.length,
    asked: picked.length,
    calls: res.calls,
    ...(opts.backend.samples && opts.backend.samples > 1 ? { samples: opts.backend.samples } : {}),
    latencyMs: Math.round(performance.now() - started),
  };
}
