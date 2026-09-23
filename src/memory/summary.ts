import { syncAgentsMd } from '../agents-md/sync.js';
import type { AgentsMdSummary, AreaSummary, RiskyNode, SyncAgentsMdOptions, SyncAgentsMdResult } from '../agents-md/types.js';
import type { GraphStore, StoredNode } from './store.js';
import { OTHER_AREA, RISK_LEVELS, areaOf, inferAreas } from './tags.js';

const MAX_ENTRY_POINTS = 5;
const MAX_RISKY = 10;
const HIGH = String(RISK_LEVELS.length - 1);

/** Short reasons for a risky node, from its yes tags. */
const REASON_WORDS: Readonly<Record<string, string>> = {
  handles_auth: 'auth',
  side_effects: 'side effects',
  touches_pii: 'personal data',
  needs_tests: 'needs tests',
};

function byLocation(a: StoredNode, b: StoredNode): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine;
}

/**
 * Builds the AGENTS.md summary from the store: areas (from area tags, or the
 * directory heuristic before tagging) with entry points, the nodes tagged High
 * risk, and the tag names. No model calls.
 */
export function buildAgentsSummary(store: GraphStore, now: Date = new Date()): AgentsMdSummary {
  const nodes = store.getNodes();
  const fns = nodes.filter((n) => n.kind === 'function' || n.kind === 'method');
  // Only area answers from the question's own label set (directory names) are kept.
  const knownAreas = new Set(inferAreas(nodes.map((n) => n.file)));
  const areaTags = new Map(store.tagsForQuestion('area').filter((t) => knownAreas.has(t.answer)).map((t) => [t.nodeId, t.answer]));
  const fileOf = new Map(nodes.map((n) => [n.id, n.file]));
  const areaFor = (id: string) => areaTags.get(id) ?? areaOf(fileOf.get(id) ?? id) ?? OTHER_AREA;
  const callers = new Map<string, number>();
  const outside = new Map<string, number>();
  const callees = new Map<string, number>();
  for (const e of store.getEdges('calls')) {
    if (e.from === e.to) continue;
    callers.set(e.to, (callers.get(e.to) ?? 0) + 1);
    callees.set(e.from, (callees.get(e.from) ?? 0) + 1);
    if (areaFor(e.from) !== areaFor(e.to)) outside.set(e.to, (outside.get(e.to) ?? 0) + 1);
  }

  const groups = new Map<string, StoredNode[]>();
  for (const n of fns) {
    const area = areaFor(n.id);
    const list = groups.get(area) ?? [];
    list.push(n);
    groups.set(area, list);
  }
  // Entry points: called from another area, or not called at all. Most outside callers first.
  const areas: AreaSummary[] = [...groups.entries()].map(([name, list]) => ({
    name,
    nodeCount: list.length,
    entryPoints: list
      .filter((n) => outside.has(n.id) || !callers.has(n.id))
      .sort(
        (a, b) =>
          (outside.get(b.id) ?? 0) - (outside.get(a.id) ?? 0) ||
          (callees.get(b.id) ?? 0) - (callees.get(a.id) ?? 0) ||
          byLocation(a, b),
      )
      .slice(0, MAX_ENTRY_POINTS)
      .map((n) => `${n.file}:${n.startLine}`),
  }));

  const riskyNodes: RiskyNode[] = [];
  for (const t of store.tagsForQuestion('risk')) {
    if (t.answer !== HIGH) continue;
    const n = store.getNode(t.nodeId);
    if (!n || n.kind === 'file') continue;
    const why = store
      .getTags(n.id)
      .filter((x) => x.answer === 'true' && REASON_WORDS[x.questionId])
      .map((x) => REASON_WORDS[x.questionId]!);
    riskyNodes.push({ name: n.name, file: n.file, line: n.startLine, p: t.p, reason: ['high risk', ...why].join(', ') });
  }
  // Probabilities that print the same count as equal.
  const pct = (p: number) => Math.round(p * 100);
  // Same risk: the node with more callers has the larger blast radius.
  const callersAt = new Map(fns.map((n) => [`${n.file}:${n.startLine}`, callers.get(n.id) ?? 0]));
  const impact = (r: RiskyNode) => callersAt.get(`${r.file}:${r.line}`) ?? 0;
  riskyNodes.sort(
    (a, b) => pct(b.p) - pct(a.p) || impact(b) - impact(a) || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line),
  );

  return {
    areas,
    riskyNodes: riskyNodes.slice(0, MAX_RISKY),
    availableTags: store.tagQuestionIds(),
    generatedAt: now.toISOString(),
  };
}

/** Writes the AGENTS.md block (and the CLAUDE.md import) from the store. */
export function syncMd(root: string, store: GraphStore, opts: SyncAgentsMdOptions = {}): Promise<SyncAgentsMdResult> {
  return syncAgentsMd(root, buildAgentsSummary(store), opts);
}
