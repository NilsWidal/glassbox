import { join } from 'node:path';
import { appendDecisionLog, ask, readDecisionLog, DECISION_LOG, STORE_DIR } from '../ask.js';
import type { GraphStore } from '../memory/store.js';
import type { Backend, DecisionRecord, ExplainBlock } from '../types.js';
import { hashState, sha256 } from '../util/hash.js';
import { decideState } from './decide.js';
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
  /**
   * The diff to re-ask over. The log keeps only a diff's file list and hash,
   * so a decision about a diff is re-asked only when this returns the same
   * diff (by default the caller passes the current working-tree diff).
   */
  diff?: () => Promise<string>;
}

/** The diff a decision was made on: the logged text (older logs), or `opts.diff` when its hash matches. */
async function recoverDiff(scope: NonNullable<DecisionRecord['scope']>, opts: ExplainDecisionOptions): Promise<string | undefined> {
  if (scope.diff !== undefined) return scope.diff;
  if (!scope.diffHash) return undefined;
  const now = opts.diff ? await opts.diff().catch(() => undefined) : undefined;
  if (now !== undefined && sha256(now) === scope.diffHash) return now;
  const files = scope.diffFiles?.length ? ` (it touched ${scope.diffFiles.slice(0, 5).join(', ')}${scope.diffFiles.length > 5 ? ', ...' : ''})` : '';
  throw new Error(
    `the log keeps only a hash of the diff behind this decision${files}, and the current diff is different; ` +
      'pass the same diff again (--diff) or ask again for a new decision',
  );
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

/** A one-line why alone is not evidence; explain must still run the evidence pass. */
function hasContent(e: ExplainBlock | undefined): e is ExplainBlock {
  return Boolean(e && (e.highlights.length || e.reasons.length || e.summary.length));
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
  const diff = await recoverDiff(scope, opts);

  let explain: ExplainBlock;
  let stateHash: string;
  let calls: number;
  let fresh: DecisionRecord;
  if (record.source === 'triage') {
    if (!diff) throw new Error('this triage decision has no stored diff');
    if (!opts.store) throw new Error('re-explaining a triage decision needs the graph store');
    const r = await triage(diff, { store: opts.store(), root: opts.root, backend, explain: budget, log: false });
    explain = r.explain;
    stateHash = r.record.stateHash;
    calls = r.calls.decide + r.calls.explain;
    fresh = r.record;
  } else {
    if (!scope.paths?.length && diff === undefined && !scope.nodes?.length) {
      throw new Error('this decision has no stored scope, so it cannot be re-asked');
    }
    const askScope = {
      ...(scope.paths?.length ? { paths: scope.paths } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(scope.nodes?.length ? { nodes: scope.nodes } : {}),
    };
    const r = await ask(askScope, record.question, { backend, root: opts.root, explain: budget, why: false, log: false });
    explain = r.explain ?? { highlights: [], reasons: [], summary: [] };
    // decide asked over its own state (hint, tags and excerpts), not over the nodes'
    // source, so rebuild that state to tell whether the code changed.
    stateHash =
      record.source === 'decide'
        ? hashState(await decideState(scope.context, scope.nodes ?? [], { root: opts.root, ...(opts.store ? { store: opts.store() } : {}) }))
        : r.record.stateHash;
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
  // Keep the why the decision was logged with.
  const oldWhy = record.explain?.why;
  if (oldWhy && !explain.why) explain = { ...explain, why: oldWhy };
  const updated: DecisionRecord = { ...record, explain };
  await appendDecisionLog(logFile, updated);
  return { record: updated, explain, cached: false, changed: stateHash !== record.stateHash, calls };
}
