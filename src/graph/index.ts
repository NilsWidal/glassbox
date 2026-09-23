import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphEdge, GraphNode } from '../types.js';
import { type FileExtract, extractSource } from './extract.js';
import { resolveEdges } from './resolve.js';
import { type WalkOptions, walkRepo } from './walk.js';

export { contentHash, normalizeSource } from './hash.js';
export { extractSource, type FileExtract, type RawCall, type RawImport } from './extract.js';
export { grammarFor, grammarWasmPath, SUPPORTED_EXTENSIONS, type Grammar } from './languages.js';
export { resolveEdges } from './resolve.js';
export { ALWAYS_SKIP, walkRepo, type WalkOptions } from './walk.js';

export interface Graph {
  /** Indexed files, POSIX paths relative to the root. */
  files: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Files skipped because they were too large or failed to parse. */
  skipped: { file: string; reason: string }[];
}

export interface BuildOptions extends WalkOptions {
  /** Files larger than this are skipped (default 1 MB); they are usually generated. */
  maxFileBytes?: number;
}

/** Builds from already-extracted files, e.g. when only some were re-parsed. */
export function assembleGraph(extracts: FileExtract[], skipped: Graph['skipped'] = []): Graph {
  const { imports, calls } = resolveEdges(extracts);
  return {
    files: extracts.map((x) => x.file),
    nodes: extracts.flatMap((x) => x.nodes),
    edges: [...extracts.flatMap((x) => x.edges), ...imports, ...calls],
    skipped,
  };
}

/** Walks, parses and links a repo. Deterministic for the same tree. */
export async function buildGraph(root: string, opts: BuildOptions = {}): Promise<Graph> {
  const maxBytes = opts.maxFileBytes ?? 1_000_000;
  const files = await walkRepo(root, opts);
  const extracts: FileExtract[] = [];
  const skipped: Graph['skipped'] = [];
  for (const file of files) {
    const abs = join(root, file);
    try {
      if ((await stat(abs)).size > maxBytes) {
        skipped.push({ file, reason: 'too large' });
        continue;
      }
      extracts.push(await extractSource(file, await readFile(abs, 'utf8')));
    } catch (err) {
      skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return assembleGraph(extracts, skipped);
}
