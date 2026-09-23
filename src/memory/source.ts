import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildGraph, type BuildOptions, type Graph } from '../graph/index.js';
import type { GraphNode, Tag } from '../types.js';
import type { GraphStore, SyncResult } from './store.js';

/** Reads files once per instance; safe to share across concurrent tasks. */
export class SourceCache {
  private readonly files = new Map<string, Promise<string[] | undefined>>();

  constructor(readonly root: string) {}

  lines(file: string): Promise<string[] | undefined> {
    let p = this.files.get(file);
    if (!p) {
      p = readFile(join(this.root, file), 'utf8').then(
        (t) => t.replace(/\r\n?/g, '\n').split('\n'),
        () => undefined,
      );
      this.files.set(file, p);
    }
    return p;
  }

  /** The node's source lines, cut to maxLines with a note, or undefined when the file is gone. */
  async text(node: Pick<GraphNode, 'file' | 'startLine' | 'endLine'>, maxLines = Infinity): Promise<string | undefined> {
    const lines = await this.lines(node.file);
    if (!lines) return undefined;
    const body = lines.slice(node.startLine - 1, node.endLine);
    if (body.length <= maxLines) return body.join('\n');
    return [...body.slice(0, maxLines), `... (${body.length - maxLines} more lines)`].join('\n');
  }
}

export interface IndexResult {
  graph: Graph;
  sync: SyncResult;
}

/** Walks and parses the repo, then writes the graph into the store (incremental by content hash). */
export async function indexRepo(root: string, store: GraphStore, opts: BuildOptions = {}): Promise<IndexResult> {
  const graph = await buildGraph(root, opts);
  return { graph, sync: store.sync(graph) };
}

/** "handles_auth=yes 0.93" style label for one tag. Score levels use `levels` names when given. */
export function tagLabel(tag: Tag, levels?: readonly string[]): string {
  const answer =
    tag.answer === 'true' ? 'yes' : tag.answer === 'false' ? 'no' : (levels?.[Number(tag.answer)] ?? tag.answer);
  return `${tag.questionId}=${answer} ${tag.p.toFixed(2)}`;
}
