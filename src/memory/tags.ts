import { mapLimit } from '../backends/sampling.js';
import { winningOption } from '../engine/answer.js';
import { decide } from '../engine/decide.js';
import { optionProbability } from '../explain/occlusion.js';
import { spanLabel } from '../scope.js';
import type { Backend, ChoiceQuestion, DecideOptions, GraphNode, Question, ScoreQuestion, Tag, YesNoQuestion } from '../types.js';
import { SourceCache, tagLabel } from './source.js';
import type { GraphStore, StoredNode } from './store.js';

export const OTHER_AREA = 'other';
export const RISK_LEVELS: readonly string[] = Object.freeze(['Low', 'Medium', 'High']);
/** File nodes up to this many lines are tagged as a whole too. */
export const SMALL_FILE_LINES = 40;
export const DEFAULT_TAG_CONCURRENCY = 4;
/** Nodes asked about in one state (one backend call per option order). */
export const DEFAULT_GROUP_SIZE = 4;
/** Longest node text shown to the model, in lines. */
export const DEFAULT_NODE_LINES = 80;
const GROUP_MAX_CHARS = 16_000;
const MAX_AREAS = 12;

/** Directory names that say nothing about an area; the next directory down names it. */
const GENERIC_DIRS = new Set(['src', 'lib', 'app', 'source', 'sources', 'pkg', 'packages', 'internal', 'main', 'java', 'python']);

/** Heuristic area of a file: its first directory that is not generic, or undefined. */
export function areaOf(file: string): string | undefined {
  for (const dir of file.split('/').slice(0, -1)) {
    const d = dir.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (d && !dir.startsWith('.') && !GENERIC_DIRS.has(d)) return d;
  }
  return undefined;
}

/** Areas from directory names, most files first, capped, plus 'other'. */
export function inferAreas(files: Iterable<string>, max = MAX_AREAS): string[] {
  const counts = new Map<string, number>();
  for (const f of new Set(files)) {
    const a = areaOf(f);
    if (a && a !== OTHER_AREA) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([a]) => a)
    .sort();
  return [...top, OTHER_AREA];
}

/**
 * The default tag questions. The area options come from the repo's directory
 * names; a repo without named areas gets no area question.
 */
export function defaultTagQuestions(areas: readonly string[]): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const a of areas) if (a !== OTHER_AREA) criteria[a] = `the ${a} part of the codebase (for example files under ${a}/)`;
  criteria[OTHER_AREA] = 'none of the listed areas, or shared utilities';
  const yesno = (instructions: string): YesNoQuestion => ({ type: 'yesno', instructions });
  const area: ChoiceQuestion = { type: 'choice', instructions: 'Which area of the codebase does this code belong to?', criteria };
  const risk: ScoreQuestion = {
    type: 'score',
    instructions:
      'How risky is it to change this code? High means a bug here could cause security, data loss, money or privacy problems, or break many callers.',
    criteria: [...RISK_LEVELS],
  };
  const named = Object.keys(criteria).length > 1;
  return {
    handles_auth: yesno('Does this code handle authentication, sessions, credentials or permissions?'),
    side_effects: yesno('Does this code have side effects such as file or network I/O, database writes, or changes to global state?'),
    touches_pii: yesno('Does this code read, store or send personal data such as names, emails, addresses, passwords or payment details?'),
    needs_tests: yesno('Is this logic important and non-trivial enough that it needs its own tests?'),
    ...(named ? { area } : {}),
    risk,
  };
}

/** Nodes the tag pass asks about: functions and methods, plus whole files that are small. */
export function isTagTarget(node: GraphNode): boolean {
  if (node.kind === 'function' || node.kind === 'method') return true;
  return node.kind === 'file' && node.endLine <= SMALL_FILE_LINES;
}

export interface TagProgress {
  done: number;
  total: number;
  /** Nodes finished in the step that triggered this report. */
  nodeIds: string[];
  failed: boolean;
}

export interface TagPassOptions {
  store: GraphStore;
  /** Default defaultTagQuestions(inferAreas(indexed files)). */
  questions?: Record<string, Question>;
  /** Groups asked at once. Default 4. */
  concurrency?: number;
  /** Nodes per state. Default 4; 1 asks each node on its own. */
  groupSize?: number;
  /** Longest node text in lines. Default 80. */
  maxNodeLines?: number;
  /** Re-ask every target, cached or not. */
  force?: boolean;
  /** Ask at most this many nodes (the rest stay stale for the next run). */
  limit?: number;
  decide?: DecideOptions;
  onProgress?: (p: TagProgress) => void;
}

export interface TagPassResult {
  targets: number;
  asked: number;
  cached: number;
  /** Nodes left for a later run because of `limit`. */
  deferred: number;
  failed: { nodeIds: string[]; error: string }[];
  tags: number;
  calls: number;
  latencyMs: number;
}

/** True when the node's tags are all present and match its content hash, and nothing marked it stale. */
export function tagsFresh(store: GraphStore, node: StoredNode, questionIds: readonly string[]): boolean {
  if (node.stale) return false;
  const tags = new Map(store.getTags(node.id).map((t) => [t.questionId, t]));
  return questionIds.every((q) => tags.get(q)?.hash === node.hash);
}

function header(n: GraphNode): string {
  return `${spanLabel(n.file, n.startLine, n.endLine)} (${n.kind} ${n.name})`;
}

/** Splits nodes into groups of at most `size` nodes and about GROUP_MAX_CHARS characters. */
function group<T extends { text: string }>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length > 0 && (cur.length >= size || chars + it.text.length > GROUP_MAX_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

const SEP = '|';

/**
 * Tags function and method nodes (and small files) with the default question
 * set. Tags are cached by content hash: only nodes that are new, changed, or
 * marked stale by a changed neighbour are asked again.
 */
export async function tagPass(root: string, backend: Backend, opts: TagPassOptions): Promise<TagPassResult> {
  const started = performance.now();
  const { store } = opts;
  const all = store.getNodes();
  const questions = opts.questions ?? defaultTagQuestions(inferAreas(all.map((n) => n.file)));
  const qids = Object.keys(questions);
  const targets = all.filter(isTagTarget);
  let todo = targets.filter((n) => opts.force || !tagsFresh(store, n, qids));
  const cached = targets.length - todo.length;
  const limit = opts.limit ?? Infinity;
  const deferred = Math.max(0, todo.length - limit);
  todo = todo.slice(0, limit);

  // Nodes that are never tagged have nothing to refresh.
  const targetIds = new Set(targets.map((n) => n.id));
  store.clearStale(all.filter((n) => n.stale && !targetIds.has(n.id)).map((n) => n.id));

  const src = new SourceCache(root);
  const maxLines = opts.maxNodeLines ?? DEFAULT_NODE_LINES;
  const items = (
    await Promise.all(todo.map(async (node) => ({ node, text: (await src.text(node, maxLines)) ?? '' })))
  ).filter((x) => x.text.trim() !== '');
  const groups = group(items, Math.max(1, opts.groupSize ?? DEFAULT_GROUP_SIZE));

  let done = 0;
  let calls = 0;
  let written = 0;
  const failed: TagPassResult['failed'] = [];
  await mapLimit(groups, Math.max(1, opts.concurrency ?? DEFAULT_TAG_CONCURRENCY), async (g) => {
    const single = g.length === 1;
    const state = g.map((x) => `### ${header(x.node)}\n${x.text}`).join('\n\n');
    const asked: Record<string, Question> = {};
    g.forEach((x, i) => {
      for (const [qid, q] of Object.entries(questions)) {
        asked[`${i}${SEP}${qid}`] = single
          ? q
          : { ...q, instructions: `About the code under the header "${header(x.node)}" only: ${q.instructions}` };
      }
    });
    const ids = g.map((x) => x.node.id);
    let ok = false;
    try {
      const res = await decide(state, asked, backend, opts.decide);
      calls += res.calls;
      const tags: Tag[] = [];
      for (const [key, answer] of Object.entries(res.answers)) {
        const [i, qid] = [Number(key.slice(0, key.indexOf(SEP))), key.slice(key.indexOf(SEP) + 1)];
        const node = g[i]!.node;
        const option = winningOption(answer);
        tags.push({ nodeId: node.id, questionId: qid, answer: option, p: optionProbability(answer, option), confidence: answer.confidence, hash: node.hash });
      }
      store.transaction(() => {
        store.setTags(tags);
        store.clearStale(ids);
      });
      written += tags.length;
      ok = true;
    } catch (err) {
      failed.push({ nodeIds: ids, error: err instanceof Error ? err.message : String(err) });
    }
    done += g.length;
    opts.onProgress?.({ done, total: items.length, nodeIds: ids, failed: !ok });
  });

  return {
    targets: targets.length,
    asked: items.length,
    cached,
    deferred,
    failed,
    tags: written,
    calls,
    latencyMs: Math.round(performance.now() - started),
  };
}

/** Tag labels for a node, e.g. ["area=auth 0.91", "handles_auth=yes 0.93", "risk=High 0.70"]. */
export function nodeTagLabels(store: GraphStore, nodeId: string): string[] {
  return store.getTags(nodeId).map((t) => tagLabel(t, t.questionId === 'risk' ? RISK_LEVELS : undefined));
}
