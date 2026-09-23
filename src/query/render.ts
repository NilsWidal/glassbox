import { answerLabel, answerP, explainLines } from '../render.js';
import { spanLabel } from '../scope.js';
import type { DecisionRecord, GraphEdge } from '../types.js';
import type { StoredNode } from '../memory/store.js';
import type { DecideQueryResult } from './decide.js';
import type { ExplainDecisionResult } from './explain.js';
import type { TriageResult } from './triage.js';
import type { WhereResult } from './where.js';

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function pad(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  return rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('   ')}`);
}

export function renderWhere(r: WhereResult): string {
  const out = [`where ${JSON.stringify(r.concept)}`];
  if (r.hits.length === 0) {
    out.push('  no node matched these words; try other words for the concept, or run `glassbox index`');
  } else {
    out.push(
      ...pad(r.hits.map((h) => [`p=${h.p.toFixed(2)}`, spanLabel(h.file, h.startLine, h.endLine), `${h.name} (${h.kind})`])),
    );
  }
  out.push(`cost  ${r.calls} call${r.calls === 1 ? '' : 's'}, ${r.asked}/${r.matched} candidates asked, ${secs(r.latencyMs)}`);
  return out.join('\n');
}

export function renderTriage(r: TriageResult): string {
  const o = r.overall;
  const out = [`RISK ${r.level}  p=${answerP(o).toFixed(2)}  conf=${o.confidence.toFixed(2)}  ${o.band}   score ${o.score.toFixed(2)}/2`];
  out.push('hunks', ...pad(r.hunks.map((h) => [spanLabel(h.file, h.startLine, h.endLine), h.level, `p=${h.p.toFixed(2)}`, h.nodes.join(', ')])));
  if (r.affected.length) {
    out.push('affected (one hop)', ...pad(r.affected.map((a) => [`${a.file}:${a.line}`, a.name, `${a.edge} ${a.via}`])));
  }
  out.push(...explainLines(r.explain));
  const explainCost = r.calls.explain ? ` + ${r.calls.explain} explain` : '';
  out.push(`cost  ${r.calls.decide} calls${explainCost}, ${secs(r.latencyMs)}, ${r.backend}${r.model ? ` (${r.model})` : ''}`);
  if (r.record.id) out.push(`id    ${r.record.id}`);
  return out.join('\n');
}

export function renderDecide(r: DecideQueryResult): string {
  const out = [
    `${r.choice}  p=${(r.probabilities[r.choice] ?? 0).toFixed(2)}  conf=${r.confidence.toFixed(2)}  ${r.band}   ${JSON.stringify(r.question.instructions)}`,
    `options  ${Object.entries(r.probabilities).map(([k, p]) => `${k} ${p.toFixed(2)}`).join('   ')}`,
    'advice only: the choice stays with you',
  ];
  if (r.context.length) out.push(`context  ${r.context.join(', ')}`);
  out.push(`cost  ${r.calls} call${r.calls === 1 ? '' : 's'}, ${secs(r.latencyMs)}, ${r.backend}${r.model ? ` (${r.model})` : ''}`);
  if (r.record.id) out.push(`id    ${r.record.id}`);
  return out.join('\n');
}

function recordHeadline(rec: DecisionRecord): string {
  return `${answerLabel(rec.answer)}  p=${answerP(rec.answer).toFixed(2)}  conf=${rec.answer.confidence.toFixed(2)}  ${rec.answer.band}   ${JSON.stringify(rec.question.instructions.split('\n')[0])}`;
}

export function renderExplained(r: ExplainDecisionResult): string {
  const out = [`${r.record.id ?? ''}  ${r.record.source ?? 'ask'}  ${r.record.ts}`, recordHeadline(r.record)];
  const lines = explainLines(r.explain);
  out.push(...(lines.length ? lines : ['no evidence found within the budget']));
  if (r.changed) out.push('note  the code changed since this decision; the evidence is for the current code');
  out.push(r.cached ? 'cost  0 calls (from the log)' : `cost  ${r.calls} calls`);
  return out.join('\n');
}

export interface GraphView {
  node: StoredNode;
  tags: string[];
  out: GraphEdge[];
  in: GraphEdge[];
}

export function renderGraph(v: GraphView): string {
  const n = v.node;
  const out = [`${n.id}  (${n.kind}, ${spanLabel(n.file, n.startLine, n.endLine)}${n.stale ? ', stale' : ''})`];
  out.push('tags', ...(v.tags.length ? v.tags.map((t) => `  ${t}`) : ['  none yet (run `glassbox index`)']));
  const edges = (title: string, list: GraphEdge[], pick: (e: GraphEdge) => string) => {
    if (list.length) out.push(title, ...list.map((e) => `  ${e.kind.padEnd(8)} ${pick(e)}`));
  };
  edges('out', v.out, (e) => e.to);
  edges('in', v.in, (e) => e.from);
  return out.join('\n');
}
