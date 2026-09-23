import { join } from 'node:path';
import { appendDecisionLog, ask, readDecisionLog, DECISION_LOG, STORE_DIR } from '../ask.js';
import type { GraphStore } from '../memory/store.js';
import type { Backend, DecisionRecord, ExplainBlock } from '../types.js';
import { triage } from './triage.js';

/** Option key with the highest calibrated (else raw) probability. */
function winner(r: DecisionRecord): string | undefined {
  const dist = r.calibrated ?? r.raw ?? {};
  let best: string | undefined;
  for (const [k, p] of Object.entries(dist)) if (best === undefined || p > dist[best]!) best = k;
  return best;
}

export interface ExplainDecisionOptions {
  root: string;
  /** Needed only when the decision has no explanation yet (or with refresh). */
  backend?: () => Backend;
  /** Needed to re-explain a triage decision. */
  store?: () => GraphStore;
  /** Default <root>/.glassbox/decisions.jsonl. */
  logFile?: string;
  /** Re-run the evidence pass even when the log already holds one. */
  refresh?: boolean;
  /** Most backend calls the explanation may spend. */
  budget?: number;
}

export interface ExplainDecisionResult {
  record: DecisionRecord;
  explain: ExplainBlock;
  /** True when the explanation came from the log without new calls. */
  cached: boolean;
  /** True when the code (the state) differs from when the decision was made. */
  changed: boolean;
  calls: number;
}

function hasContent(e: ExplainBlock | undefined): e is ExplainBlock {
  return Boolean(e && (e.highlights.length || e.reasons.length || e.summary.length || e.why));
}

/** Latest logged record whose id equals or starts with `id` (at least 4 characters). */
export function findDecision(records: readonly DecisionRecord[], id: string): DecisionRecord | undefined {
  const want = id.trim();
  if (want.length < 4) throw new Error('decision id must have at least 4 characters');
  const hits = records.filter((r) => r.id?.startsWith(want));
  const ids = new Set(hits.map((r) => r.id));
  if (ids.size > 1) throw new Error(`decision id "${want}" is ambiguous: ${[...ids].slice(0, 5).join(', ')}`);
  return hits[hits.length - 1];
}

/**
 * Adds evidence and reasons to an earlier decision. Cached explanations are
 * returned as they are; otherwise the decision is re-asked with hide-and-re-ask
 * over its stored scope and the explained record is appended to the log.
 */
export async function explainDecision(id: string, opts: ExplainDecisionOptions): Promise<ExplainDecisionResult> {
  const logFile = opts.logFile ?? join(opts.root, STORE_DIR, DECISION_LOG);
  const record = findDecision(await readDecisionLog(logFile), id);
  if (!record) throw new Error(`no decision with id "${id}" in ${logFile}`);
  if (hasContent(record.explain) && !opts.refresh) {
    return { record, explain: record.explain, cached: true, changed: false, calls: 0 };
  }
  if (!opts.backend) throw new Error('this decision has no stored explanation; a backend is needed to make one');
  const backend = opts.backend();
  const budget = opts.budget !== undefined ? { budget: opts.budget } : {};
  const scope = record.scope ?? {};

  let explain: ExplainBlock;
  let stateHash: string;
  let calls: number;
  let fresh: DecisionRecord;
  if (record.source === 'triage') {
    if (!scope.diff) throw new Error('this triage decision has no stored diff');
    if (!opts.store) throw new Error('re-explaining a triage decision needs the graph store');
    const r = await triage(scope.diff, { store: opts.store(), root: opts.root, backend, explain: budget, log: false });
    explain = r.explain;
    stateHash = r.record.stateHash;
    calls = r.calls.decide + r.calls.explain;
    fresh = r.record;
  } else {
    if (!scope.paths?.length && scope.diff === undefined && !scope.nodes?.length) {
      throw new Error('this decision has no stored scope, so it cannot be re-asked');
    }
    const r = await ask(scope, record.question, { backend, root: opts.root, explain: budget, log: false });
    explain = r.explain ?? { highlights: [], reasons: [], summary: [] };
    stateHash = r.record.stateHash;
    calls = r.calls.decide + r.calls.explain + r.calls.why;
    fresh = r.record;
  }
  // Evidence for a different answer must not be stored next to the old one.
  const was = winner(record);
  const now = winner(fresh);
  if (was !== undefined && now !== undefined && was !== now) {
    throw new Error(
      `re-asking now gives a different answer (${now}, logged ${was})${stateHash !== record.stateHash ? ' and the code changed' : ''}, ` +
        'so its evidence would not explain the logged decision; run the question again with --explain for a new decision',
    );
  }
  const updated: DecisionRecord = { ...record, explain };
  await appendDecisionLog(logFile, updated);
  return { record: updated, explain, cached: false, changed: stateHash !== record.stateHash, calls };
}
