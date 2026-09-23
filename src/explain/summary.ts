import { spanLabel, type Chunk } from '../scope.js';
import type { GraphEdge, GraphNode, Highlight, ReasonCode } from '../types.js';

export interface SummaryInput {
  highlights: readonly Highlight[];
  reasons: readonly ReasonCode[];
  /** Chunks of the state, used to find the function around each highlight. */
  chunks: readonly Chunk[];
  /** Graph nodes and edges of the files in scope, for the call path. */
  nodes?: readonly GraphNode[];
  edges?: readonly GraphEdge[];
  /** Reasons at or above this P(yes) are listed as "because". Default 0.5. */
  reasonThreshold?: number;
  /** Reasons at or below this P(yes) are listed as "ruled out". Default 0.2. */
  ruledOutThreshold?: number;
  maxLines?: number;
}

const ARROW = ' -> ';

/** "-0.61" / "+0.22". */
export function formatDelta(d: number): string {
  return `${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(2)}`;
}

/** A highlight's comment, or its measured effect when it has none. Never anything else. */
function commentFor(h: Highlight, withSpan = true): string {
  if (h.comment) return h.comment;
  return `\u0394p ${formatDelta(h.deltaP)}${withSpan ? ` at ${spanLabel(h.file, h.startLine, h.endLine)}` : ''}`;
}

function display(n: GraphNode): string {
  return n.kind === 'class' ? n.name : `${n.name}()`;
}

/**
 * Pseudo-code summary built ONLY from highlights, reason codes and the call
 * edges between the functions that contain highlights (plus their direct
 * callers). Each line is a call path with the highlight's comment, e.g.
 *   login() -> verifySession()   # TTL read from env
 * It never states a threshold, value or fact that is not in those inputs.
 */
export function buildSummary(input: SummaryInput): string[] {
  const nodes = new Map((input.nodes ?? []).map((n) => [n.id, n]));
  const chunkOf = (h: Highlight) =>
    input.chunks.find((c) => c.file === h.file && c.startLine === h.startLine && c.endLine === h.endLine);

  // Strongest highlight per enclosing node; highlights outside any node stay loose.
  const byNode = new Map<string, Highlight>();
  const loose: Highlight[] = [];
  for (const h of input.highlights) {
    const id = chunkOf(h)?.nodeId;
    if (id && nodes.has(id)) {
      const prev = byNode.get(id);
      if (!prev || Math.abs(h.deltaP) > Math.abs(prev.deltaP)) byNode.set(id, h);
    } else loose.push(h);
  }

  const calls = (input.edges ?? []).filter((e) => e.kind === 'calls' && e.from !== e.to && nodes.has(e.from) && nodes.has(e.to));
  const inPath = new Set(byNode.keys());
  for (const e of calls) {
    if (byNode.has(e.to) && nodes.get(e.from)!.kind !== 'file') inPath.add(e.from);
  }
  const edges = calls.filter((e) => inPath.has(e.from) && inPath.has(e.to));
  const children = new Map<string, string[]>();
  for (const e of edges) {
    const list = children.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    children.set(e.from, list);
  }
  const hasParent = new Set(edges.map((e) => e.to));
  const order = (ids: Iterable<string>) =>
    [...ids].sort((a, b) => {
      const na = nodes.get(a)!;
      const nb = nodes.get(b)!;
      return na.file < nb.file ? -1 : na.file > nb.file ? 1 : na.startLine - nb.startLine;
    });

  const rows: { text: string; comment?: string }[] = [];
  const visited = new Set<string>();
  const printed = new Set<string>();
  const emit = (path: string[]) => {
    const id = path[path.length - 1]!;
    let text = '';
    path.forEach((p, i) => {
      const seg = display(nodes.get(p)!);
      const blank = i < path.length - 1 && printed.has(p);
      const joiner = i === 0 ? '' : blank ? ' '.repeat(ARROW.length) : ARROW;
      text += joiner + (blank ? ' '.repeat(seg.length) : seg);
    });
    path.forEach((p) => printed.add(p));
    const h = byNode.get(id);
    rows.push(h ? { text, comment: commentFor(h) } : path.length > 1 ? { text, comment: 'not highlighted' } : { text });
  };
  const walk = (path: string[]) => {
    const id = path[path.length - 1]!;
    if (visited.has(id)) return;
    visited.add(id);
    // Strongest evidence first, then source order.
    const strength = (k: string) => Math.abs(byNode.get(k)?.deltaP ?? 0);
    const kids = order(children.get(id) ?? [])
      .filter((k) => !visited.has(k))
      .sort((a, b) => strength(b) - strength(a));
    // A caller with no highlight of its own only appears as the start of its children's lines.
    if (path.length > 1 || byNode.has(id) || kids.length === 0) emit(path);
    for (const k of kids) walk([...path, k]);
  };
  const roots = order([...inPath].filter((id) => !hasParent.has(id)));
  for (const r of roots) walk([r]);
  // Cycles leave nodes without a root; start from any highlighted node not yet shown.
  for (const id of order(byNode.keys())) if (!visited.has(id)) walk([id]);

  for (const h of loose) rows.push({ text: spanLabel(h.file, h.startLine, h.endLine), comment: commentFor(h, false) });

  const width = Math.max(0, ...rows.filter((r) => r.comment).map((r) => r.text.length));
  const lines = rows.map((r) => (r.comment ? `${r.text.padEnd(width)}   # ${r.comment}` : r.text));

  const yes = input.reasonThreshold ?? 0.5;
  const no = input.ruledOutThreshold ?? 0.2;
  const because = input.reasons.filter((r) => r.p >= yes);
  const ruledOut = input.reasons.filter((r) => r.p <= no);
  if (because.length) lines.push(`because: ${because.map((r) => `${r.code} (p=${r.p.toFixed(2)})`).join(', ')}`);
  if (ruledOut.length) lines.push(`ruled out: ${ruledOut.map((r) => `${r.code} (p=${r.p.toFixed(2)})`).join(', ')}`);

  const max = input.maxLines ?? 12;
  return lines.length > max ? [...lines.slice(0, max - 1), `... ${lines.length - max + 1} more`] : lines;
}
