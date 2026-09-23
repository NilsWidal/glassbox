import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { extractSource, type FileExtract } from './graph/extract.js';
import { grammarFor } from './graph/languages.js';
import { walkRepo } from './graph/walk.js';
import type { GraphNode } from './types.js';

/** What a question is about: files or directories, a unified diff, or graph node ids. */
export interface AskScope {
  /** Files or directories, relative to the root or absolute inside it. */
  paths?: string[];
  /** Unified diff text (git diff output). */
  diff?: string;
  /** Graph node ids such as "src/auth/session.ts#verifySession". */
  nodes?: string[];
}

/** One hideable piece of the state, shown to the model under a `### file:lines` header. */
export interface Chunk {
  /** Stable id within one ask: c1, c2, ... */
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Innermost function, method or class that contains the chunk, when known. */
  nodeId?: string;
  /** True when `text` holds unified diff lines (+/-/space prefixed). */
  diff?: boolean;
  /** Diff chunks: the lines that were added or removed (context lines left out). */
  changedLines?: number[];
  /** Diff chunks of a renamed or moved file: its old path (what the graph still knows it as). */
  renamedFrom?: string;
  /** A rename or move with no content change (git's rename headers without hunks). */
  renameOnly?: boolean;
}

export interface ChunkOptions {
  /** Longest chunk in lines; longer statement groups are split. Default 8. */
  maxLines?: number;
}

export interface BuildScopeOptions extends ChunkOptions {
  /** Repo root. Default process.cwd(). */
  root?: string;
  /** Refuse states larger than this many characters. Default 60000. */
  maxChars?: number;
}

export interface ScopeResult {
  chunks: Chunk[];
  /** Parsed files (supported languages only), for node lookup and call paths. */
  extracts: FileExtract[];
}

export const DEFAULT_CHUNK_LINES = 8;
export const DEFAULT_MAX_CHARS = 60_000;

/** `file:12` or `file:12-18`. */
export function spanLabel(file: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${file}:${startLine}` : `${file}:${startLine}-${endLine}`;
}

/** The header the model sees above a chunk; relevance questions quote it. */
export function chunkHeader(c: Chunk): string {
  return `${spanLabel(c.file, c.startLine, c.endLine)}${c.diff ? ' (diff)' : ''}`;
}

/** The state text: every chunk not in `hidden`, each under its header. */
export function renderState(chunks: readonly Chunk[], hidden?: ReadonlySet<string>): string {
  return chunks
    .filter((c) => !hidden?.has(c.id))
    .map((c) => `### ${chunkHeader(c)}\n${c.text}`)
    .join('\n\n');
}

/**
 * Splits source into statement groups: runs of non-blank lines separated by
 * blank lines, with runs longer than maxLines cut into windows.
 */
export function chunkText(file: string, text: string, opts: ChunkOptions & { firstLine?: number } = {}): Omit<Chunk, 'id'>[] {
  const maxLines = Math.max(1, opts.maxLines ?? DEFAULT_CHUNK_LINES);
  const first = opts.firstLine ?? 1;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Omit<Chunk, 'id'>[] = [];
  let start = -1;
  const flush = (end: number) => {
    for (let s = start; s < end; s += maxLines) {
      const e = Math.min(end, s + maxLines);
      out.push({ file, startLine: first + s, endLine: first + e - 1, text: lines.slice(s, e).join('\n') });
    }
    start = -1;
  };
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      if (start >= 0) flush(i);
    } else if (start < 0) start = i;
  });
  if (start >= 0) flush(lines.length);
  return out;
}

/**
 * Chunks a unified diff by hunk, in windows of at most maxLines diff lines.
 * Line numbers are new-file lines; removed lines count at the position they
 * were removed from. A deleted file keeps its old path and line numbers.
 * A renamed file's chunks carry `renamedFrom`; a pure rename (git's
 * "rename from/rename to" headers, no hunks) becomes one chunk at line 1.
 */
export function chunkDiff(diff: string, opts: ChunkOptions = {}): Omit<Chunk, 'id'>[] {
  const maxLines = Math.max(1, opts.maxLines ?? DEFAULT_CHUNK_LINES);
  const out: Omit<Chunk, 'id'>[] = [];
  let oldPath: string | undefined;
  let file: string | undefined;
  let lineNo = 0;
  let useOld = false;
  let buf: { text: string; line: number }[] = [];
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let sectionChunks = 0;

  const flush = () => {
    if (file && buf.length > 0 && buf.some((l) => l.text.startsWith('+') || l.text.startsWith('-'))) {
      out.push({
        file,
        startLine: Math.min(...buf.map((l) => l.line)),
        endLine: Math.max(...buf.map((l) => l.line)),
        text: buf.map((l) => l.text).join('\n'),
        diff: true,
        changedLines: [...new Set(buf.filter((l) => l.text.startsWith('+') || l.text.startsWith('-')).map((l) => l.line))],
        ...(renameFrom !== undefined && renameFrom !== file ? { renamedFrom: renameFrom } : {}),
      });
      sectionChunks++;
    }
    buf = [];
  };

  /** End of one file's section: a rename without hunks still counts as a change to the file. */
  const endSection = () => {
    flush();
    if (renameFrom !== undefined && renameTo !== undefined && renameFrom !== renameTo && sectionChunks === 0) {
      out.push({
        file: renameTo,
        startLine: 1,
        endLine: 1,
        text: `rename from ${renameFrom}\nrename to ${renameTo}`,
        diff: true,
        changedLines: [1],
        renamedFrom: renameFrom,
        renameOnly: true,
      });
    }
    renameFrom = undefined;
    renameTo = undefined;
    sectionChunks = 0;
  };

  const lines = diff.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.startsWith('diff --git ')) {
      endSection();
      file = undefined;
      oldPath = undefined;
      lineNo = 0;
      continue;
    }
    // Extended headers come before the first hunk; git quotes odd names, which are left as they are.
    if (lineNo === 0 && raw.startsWith('rename from ')) {
      renameFrom = raw.slice('rename from '.length).trim();
      continue;
    }
    if (lineNo === 0 && raw.startsWith('rename to ')) {
      renameTo = raw.slice('rename to '.length).trim();
      continue;
    }
    // A file header only when followed by +++, so a removed "-- x" line is not mistaken for one.
    if (raw.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      flush();
      oldPath = stripDiffPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const next = stripDiffPath(raw.slice(4));
      useOld = next === undefined;
      file = next ?? oldPath;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      flush();
      lineNo = Number(useOld ? hunk[1] : hunk[2]);
      continue;
    }
    if (!file || lineNo === 0) continue;
    const tag = raw.charAt(0);
    if (tag !== ' ' && tag !== '+' && tag !== '-') continue;
    // Removed lines sit at the current new-file line; other lines advance it.
    const at = tag === '-' && !useOld ? Math.max(1, lineNo) : lineNo;
    buf.push({ text: raw, line: at });
    if (tag !== '-' || useOld) lineNo++;
    if (buf.length >= maxLines) flush();
  }
  endSection();
  return out;
}

function stripDiffPath(p: string): string | undefined {
  const path = p.replace(/\t.*$/, '').trim();
  if (path === '/dev/null') return undefined;
  return path.replace(/^[ab]\//, '');
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Resolves a user path to a POSIX path relative to root; rejects paths outside it. */
function relPath(root: string, p: string): string {
  const rel = toPosix(relative(root, isAbsolute(p) ? p : join(root, p)));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path is outside the repo root: ${p}`);
  return rel;
}

/** True for a relative path that stays inside root (node ids and diff headers use these). */
function insideRoot(root: string, p: string): boolean {
  if (isAbsolute(p)) return false;
  try {
    relPath(root, p);
    return true;
  } catch {
    return false;
  }
}

/** Files that likely hold secrets; never sent to the model, even when named or in a diff. */
export const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx))$/i;

/** True when a diff chunk's file (or the file it was renamed from) looks like it holds secrets. */
export function isSecretChunk(c: Pick<Chunk, 'file' | 'renamedFrom'>): boolean {
  return SECRET_FILE.test(c.file) || (c.renamedFrom !== undefined && SECRET_FILE.test(c.renamedFrom));
}

/** Diff chunks without the ones for secret-looking files, which are never sent to the model. */
export function safeDiffChunks<T extends Pick<Chunk, 'file' | 'renamedFrom'>>(chunks: readonly T[]): T[] {
  return chunks.filter((c) => !isSecretChunk(c));
}

/** Throws when a path under root resolves (through symlinks) outside it. Missing files pass. */
async function assertResolvesInside(root: string, rel: string): Promise<void> {
  const real = await realpath(join(root, rel)).catch(() => undefined);
  if (real === undefined) return;
  const back = relative(await realpath(root), real);
  if (back.startsWith('..') || isAbsolute(back)) throw new Error(`path resolves outside the repo root: ${rel}`);
}

async function readInside(root: string, rel: string): Promise<string> {
  await assertResolvesInside(root, rel);
  return readFile(join(root, rel), 'utf8');
}

async function listFiles(root: string, paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    const rel = relPath(root, p);
    await assertResolvesInside(root, rel);
    if (SECRET_FILE.test(rel)) throw new Error(`refusing to send a file that may hold secrets: ${p}`);
    const info = await stat(join(root, rel)).catch(() => undefined);
    if (!info) throw new Error(`no such file or directory: ${p}`);
    if (info.isDirectory()) {
      const prefix = rel === '' ? '' : `${rel}/`;
      files.push(...(await walkRepo(root)).filter((f) => f.startsWith(prefix)));
    } else files.push(rel);
  }
  return [...new Set(files)];
}

async function tryExtract(root: string, file: string): Promise<FileExtract | undefined> {
  if (!grammarFor(file)) return undefined;
  try {
    return await extractSource(file, await readInside(root, file));
  } catch {
    return undefined;
  }
}

/** Innermost non-file node containing the line, if any. */
export function nodeAt(nodes: readonly GraphNode[], file: string, line: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (n.file !== file || n.kind === 'file' || line < n.startLine || line > n.endLine) continue;
    if (!best || n.endLine - n.startLine < best.endLine - best.startLine) best = n;
  }
  return best;
}

/**
 * Reads a scope into chunks with file:line headers. Files are parsed when the
 * language is supported so chunks know their enclosing function.
 */
export async function buildScope(scope: AskScope, opts: BuildScopeOptions = {}): Promise<ScopeResult> {
  const root = opts.root ?? process.cwd();
  const raw: Omit<Chunk, 'id'>[] = [];
  const extracts = new Map<string, FileExtract>();
  const extractFor = async (file: string) => {
    if (!extracts.has(file)) {
      const x = await tryExtract(root, file);
      if (x) extracts.set(file, x);
    }
    return extracts.get(file);
  };

  for (const file of await listFiles(root, scope.paths ?? [])) {
    const text = await readInside(root, file);
    raw.push(...chunkText(file, text, opts));
    await extractFor(file);
  }

  if (scope.diff) {
    // Diff headers are untrusted: drop chunks whose path leaves the root, and chunks of secret-looking files.
    const chunks = safeDiffChunks(chunkDiff(scope.diff, opts)).filter(
      (c) => insideRoot(root, c.file) && (c.renamedFrom === undefined || insideRoot(root, c.renamedFrom)),
    );
    raw.push(...chunks);
    for (const f of new Set(chunks.map((c) => c.file))) await extractFor(f);
  }

  for (const id of scope.nodes ?? []) {
    const file = id.split('#')[0]!;
    if (!insideRoot(root, file)) throw new Error(`node id is outside the repo root: ${id}`);
    const x = await extractFor(file);
    const node = x?.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`unknown node id: ${id}`);
    const lines = (await readInside(root, file)).replace(/\r\n?/g, '\n').split('\n');
    const text = lines.slice(node.startLine - 1, node.endLine).join('\n');
    raw.push(...chunkText(file, text, { ...opts, firstLine: node.startLine }));
  }

  // Drop exact duplicates (a node inside a listed file, for example).
  const seen = new Set<string>();
  const nodes = [...extracts.values()].flatMap((x) => x.nodes);
  const chunks: Chunk[] = [];
  for (const c of raw) {
    const key = `${c.diff ? 'd' : 'f'}:${c.file}:${c.startLine}:${c.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk: Chunk = { id: `c${chunks.length + 1}`, ...c };
    // First line inside a node wins, so a leading comment does not hide the enclosing function.
    for (let line = c.startLine; line <= c.endLine; line++) {
      const node = nodeAt(nodes, c.file, line);
      if (node) {
        chunk.nodeId = node.id;
        break;
      }
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) throw new Error('the scope is empty: pass --path, --diff or --node with some code');
  const size = renderState(chunks).length;
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (size > max) {
    throw new Error(`the scope is too large (${size} characters, limit ${max}); narrow it with a smaller --path, a --diff or --node ids`);
  }
  return { chunks, extracts: [...extracts.values()] };
}
