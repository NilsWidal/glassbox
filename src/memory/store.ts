import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertNotSymlinkSync, ensureStoreDirSync } from '../util/safefs.js';
import { trackedByGit } from '../util/tracked.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeKind, Tag } from '../types.js';

export const STORE_DIR = '.glassbox';
export const STORE_FILE = 'graph.db';
/** Sidecar with the time of the last full parse, next to graph.db. */
export const META_FILE = 'graph.meta.json';
/** Stored in PRAGMA user_version. Bump it when SCHEMA changes; older stores are then rebuilt. */
export const SCHEMA_VERSION = 1;
/** Oldest Node release with node:sqlite available without a flag. */
export const MIN_NODE_VERSION = '22.13';

type SqliteModule = typeof import('node:sqlite');

/**
 * Loads node:sqlite on first use (not at import time), so commands without the
 * graph run on any Node, and an old Node gets one clear error instead of a crash.
 */
export function loadSqlite(get: (id: string) => unknown = builtin): SqliteModule {
  let mod: unknown;
  // Node prints "SQLite is an experimental feature" on first load; glassbox
  // output (and the terminal `glassbox run` hands to the agent) stays clean.
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    mod = get('node:sqlite');
  } catch {
    mod = undefined;
  } finally {
    process.emitWarning = emit;
  }
  if (!mod || typeof (mod as Partial<SqliteModule>).DatabaseSync !== 'function') {
    throw new Error(
      `the glassbox code graph needs node:sqlite, which Node ${process.versions.node} does not provide; ` +
        `use Node ${MIN_NODE_VERSION} or newer`,
    );
  }
  return mod as SqliteModule;
}

function builtin(id: string): unknown {
  const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  return get ? get.call(process, id) : undefined;
}

export interface StoredNode extends GraphNode {
  /** True when the node or a neighbour changed since its tags were last refreshed. */
  stale: boolean;
}

export interface SyncResult {
  added: string[];
  changed: string[];
  removed: string[];
  /** Every node now marked stale by this sync (changed, added and one-hop dependents). */
  stale: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  lang TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
CREATE TABLE IF NOT EXISTS tags (
  node_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  p REAL NOT NULL,
  confidence REAL NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, question_id)
);
CREATE INDEX IF NOT EXISTS tags_question ON tags(question_id);
`;

type Row = Record<string, unknown>;

/** Columns per table, in order, as SCHEMA creates them. */
const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  nodes: ['id', 'kind', 'file', 'name', 'start_line', 'end_line', 'hash', 'lang', 'stale'],
  edges: ['from_id', 'to_id', 'kind'],
  tags: ['node_id', 'question_id', 'answer', 'p', 'confidence', 'hash', 'updated_at'],
};
const EXPECTED_INDEXES = new Set(['nodes_file', 'edges_to', 'tags_question']);

/**
 * Why an existing store file cannot be trusted, or undefined when it looks
 * like one glassbox wrote: it opens, passes quick_check, has this schema
 * version (or 0, from before versions were stamped), exactly the expected
 * tables and columns, and no triggers or views.
 */
export function storeProblem(file: string): string | undefined {
  const { DatabaseSync } = loadSqlite();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check').all() as Row[];
    if (check.length !== 1 || Object.values(check[0]!)[0] !== 'ok') return 'it failed the integrity check';
    const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version !== SCHEMA_VERSION && version !== 0) return `it has schema version ${version}, expected ${SCHEMA_VERSION}`;
    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
    for (const o of objects) {
      const type = String(o.type);
      const name = String(o.name);
      if (type === 'table' && name in EXPECTED_COLUMNS) continue;
      if (type === 'index' && EXPECTED_INDEXES.has(name)) continue;
      return `it holds an unexpected ${type} "${name}"`;
    }
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const got = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name));
      if (got.join(',') !== columns.join(',')) return `its ${table} table does not match this version`;
    }
    return undefined;
  } catch (err) {
    return `it could not be read (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    db?.close();
  }
}

function toNode(r: Row): StoredNode {
  return {
    id: String(r.id),
    kind: String(r.kind) as NodeKind,
    file: String(r.file),
    name: String(r.name),
    startLine: Number(r.start_line),
    endLine: Number(r.end_line),
    hash: String(r.hash),
    lang: String(r.lang),
    stale: Number(r.stale) === 1,
  };
}

function toEdge(r: Row): GraphEdge {
  return { from: String(r.from_id), to: String(r.to_id), kind: String(r.kind) as EdgeKind };
}

function toTag(r: Row): Tag {
  return {
    nodeId: String(r.node_id),
    questionId: String(r.question_id),
    answer: String(r.answer),
    p: Number(r.p),
    confidence: Number(r.confidence),
    hash: String(r.hash),
  };
}

/** The graph and tag store at <repo>/.glassbox/graph.db (node:sqlite, no native deps). */
export class GraphStore {
  readonly db: DatabaseSync;
  private txDepth = 0;
  /** Set by open() when an existing store was not trusted and was rebuilt empty: the reason. */
  rebuilt?: string;

  /**
   * `path` may be ':memory:'. Use GraphStore.open(repoRoot) for the standard
   * location. readOnly opens an existing store without creating or changing
   * anything (the hot-path readers use it) and throws when its schema version
   * is not this one.
   */
  constructor(
    readonly path: string,
    opts: { readOnly?: boolean } = {},
  ) {
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {});
    // Hooks, the MCP server and the background worker may use the store at once.
    this.db.exec('PRAGMA busy_timeout = 2000;');
    const version = () => Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (opts.readOnly) {
      if (version() !== SCHEMA_VERSION) {
        this.db.close();
        throw new Error(`${path} has schema version ${version()}, expected ${SCHEMA_VERSION}`);
      }
      return;
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    if (version() === 0) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Opens <repoRoot>/.glassbox/graph.db read-only for a fast lookup, or returns
   * undefined when there is none or when git tracks it (a store committed to
   * the repo came with the clone). Unlike open(), it never deletes or rebuilds
   * anything, so callers must still treat what it returns as untrusted text.
   */
  static openForRead(repoRoot: string): GraphStore | undefined {
    const dir = join(repoRoot, STORE_DIR);
    const file = join(dir, STORE_FILE);
    if (!existsSync(file)) return undefined;
    const files = [file, `${file}-wal`, `${file}-shm`];
    for (const f of [dir, ...files]) assertNotSymlinkSync(f);
    // A store that git tracks came with the clone; its rows are someone else's text. open() rebuilds it.
    if (files.some((f) => existsSync(f) && trackedByGit(repoRoot, f))) return undefined;
    return new GraphStore(file, { readOnly: true });
  }

  /** Records that a full parse just finished (see indexedAt). No-op for an in-memory store. */
  markIndexed(at = Date.now()): void {
    if (this.path === ':memory:') return;
    const file = join(dirname(this.path), META_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      assertNotSymlinkSync(file);
      writeFileSync(tmp, `${JSON.stringify({ indexedAt: at })}\n`, { flag: 'w' });
      renameSync(tmp, file);
    } catch {
      rmSync(tmp, { force: true });
    }
  }

  /** Epoch ms of the last full parse, or undefined when unknown. */
  indexedAt(): number | undefined {
    return readIndexedAt(dirname(this.path));
  }

  /**
   * Opens <repoRoot>/.glassbox/graph.db. An existing file is checked first: one
   * that git tracks (it came with a clone, so someone else wrote it) or that
   * fails storeProblem() is deleted and rebuilt empty; the graph is a cache
   * and is re-indexed on next use.
   */
  static open(repoRoot: string): GraphStore {
    const dir = ensureStoreDirSync(repoRoot, STORE_DIR);
    const file = join(dir, STORE_FILE);
    const files = [file, `${file}-wal`, `${file}-shm`];
    for (const f of files) assertNotSymlinkSync(f);
    let reason: string | undefined;
    if (existsSync(file)) {
      reason = files.some((f) => existsSync(f) && trackedByGit(repoRoot, f)) ? 'it is committed to git' : storeProblem(file);
      if (reason) for (const f of files) rmSync(f, { force: true });
    }
    const store = new GraphStore(file);
    if (reason) store.rebuilt = reason;
    return store;
  }

  close(): void {
    this.db.close();
  }

  /** Runs fn in one transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN');
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  // ------------------------------------------------------------------ nodes

  /** Inserts or updates by id. A node whose hash changed becomes stale; others keep their flag. */
  upsertNodes(nodes: readonly GraphNode[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, kind, file, name, start_line, end_line, hash, lang, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, file = excluded.file, name = excluded.name,
        start_line = excluded.start_line, end_line = excluded.end_line, lang = excluded.lang,
        stale = CASE WHEN nodes.hash = excluded.hash THEN nodes.stale ELSE 1 END,
        hash = excluded.hash`);
    this.transaction(() => {
      for (const n of nodes) stmt.run(n.id, n.kind, n.file, n.name, n.startLine, n.endLine, n.hash, n.lang);
    });
  }

  /** Deletes nodes with their edges (both directions) and tags. */
  deleteNodes(ids: readonly string[]): void {
    const dn = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    const de = this.db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');
    const dt = this.db.prepare('DELETE FROM tags WHERE node_id = ?');
    this.transaction(() => {
      for (const id of ids) {
        dn.run(id);
        de.run(id, id);
        dt.run(id);
      }
    });
  }

  getNode(id: string): StoredNode | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined;
    return r ? toNode(r) : undefined;
  }

  getNodes(filter: { file?: string; kind?: NodeKind } = {}): StoredNode[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.file !== undefined) {
      where.push('file = ?');
      args.push(filter.file);
    }
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    const sql = `SELECT * FROM nodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY file, start_line, id`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toNode);
  }

  /** id -> stored hash, for all nodes. */
  hashes(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, hash FROM nodes').all() as Row[];
    return new Map(rows.map((r) => [String(r.id), String(r.hash)]));
  }

  /** Ids whose hash differs from the stored one, or that are not stored yet. */
  changedNodes(newHashes: ReadonlyMap<string, string> | Readonly<Record<string, string>>): string[] {
    const entries = newHashes instanceof Map ? [...newHashes.entries()] : Object.entries(newHashes);
    const stored = this.hashes();
    return entries.filter(([id, h]) => stored.get(id) !== h).map(([id]) => id);
  }

  // ------------------------------------------------------------------ edges

  upsertEdges(edges: readonly GraphEdge[]): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)');
    this.transaction(() => {
      for (const e of edges) stmt.run(e.from, e.to, e.kind);
    });
  }

  getEdges(kind?: EdgeKind): GraphEdge[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM edges WHERE kind = ? ORDER BY from_id, to_id').all(kind)
      : this.db.prepare('SELECT * FROM edges ORDER BY from_id, to_id, kind').all();
    return (rows as Row[]).map(toEdge);
  }

  edgesFrom(id: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM edges WHERE from_id = ? AND kind = ? ORDER BY to_id').all(id, kind)
      : this.db.prepare('SELECT * FROM edges WHERE from_id = ? ORDER BY kind, to_id').all(id);
    return (rows as Row[]).map(toEdge);
  }

  edgesTo(id: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM edges WHERE to_id = ? AND kind = ? ORDER BY from_id').all(id, kind)
      : this.db.prepare('SELECT * FROM edges WHERE to_id = ? ORDER BY kind, from_id').all(id);
    return (rows as Row[]).map(toEdge);
  }

  /** Nodes one hop away that depend on `ids` (they import, call or contain them). */
  dependents(ids: Iterable<string>): string[] {
    const stmt = this.db.prepare('SELECT DISTINCT from_id FROM edges WHERE to_id = ?');
    const out = new Set<string>();
    for (const id of ids) for (const r of stmt.all(id) as Row[]) out.add(String(r.from_id));
    return [...out];
  }

  // -------------------------------------------------------------- staleness

  /**
   * Marks ids stale and, unless propagate is false, their one-hop dependents.
   * Returns every id that exists and is now stale.
   */
  markStale(ids: Iterable<string>, opts: { propagate?: boolean } = {}): string[] {
    const set = new Set(ids);
    if (opts.propagate !== false) for (const d of this.dependents(set)) set.add(d);
    const stmt = this.db.prepare('UPDATE nodes SET stale = 1 WHERE id = ?');
    const out: string[] = [];
    this.transaction(() => {
      for (const id of set) if (Number(stmt.run(id).changes) > 0) out.push(id);
    });
    return out.sort();
  }

  staleNodes(): StoredNode[] {
    return (this.db.prepare('SELECT * FROM nodes WHERE stale = 1 ORDER BY file, start_line, id').all() as Row[]).map(
      toNode,
    );
  }

  /** Clears the stale flag, e.g. after re-tagging. No ids clears every node. */
  clearStale(ids?: Iterable<string>): void {
    if (!ids) {
      this.db.exec('UPDATE nodes SET stale = 0');
      return;
    }
    const stmt = this.db.prepare('UPDATE nodes SET stale = 0 WHERE id = ?');
    this.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
  }

  // ------------------------------------------------------------------- sync

  /**
   * Writes a freshly built graph. With `files`, only nodes and outgoing edges
   * of those files are replaced (incremental re-index); otherwise everything.
   * Changed and added nodes, nodes whose neighbour was removed, and one-hop
   * dependents of changed nodes (before and after the update) become stale.
   */
  sync(graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }, opts: { files?: readonly string[] } = {}): SyncResult {
    return this.transaction(() => {
      const scope = opts.files ? new Set(opts.files) : null;
      const inScope = (file: string) => !scope || scope.has(file);
      const newNodes = graph.nodes.filter((n) => inScope(n.file));
      const newIds = new Set(newNodes.map((n) => n.id));
      const stored = this.getNodes().filter((n) => inScope(n.file));
      const storedHash = new Map(stored.map((n) => [n.id, n.hash]));

      const added = newNodes.filter((n) => !storedHash.has(n.id)).map((n) => n.id);
      const changed = newNodes.filter((n) => storedHash.has(n.id) && storedHash.get(n.id) !== n.hash).map((n) => n.id);
      const removed = stored.filter((n) => !newIds.has(n.id)).map((n) => n.id);

      const touched = [...changed, ...removed];
      const before = this.dependents(touched);

      this.deleteNodes(removed);
      const delFrom = this.db.prepare('DELETE FROM edges WHERE from_id = ?');
      for (const n of stored) delFrom.run(n.id);
      this.upsertNodes(newNodes);
      this.upsertEdges(graph.edges.filter((e) => newIds.has(e.from)));

      const after = this.dependents([...changed, ...added]);
      const stale = this.markStale([...changed, ...added, ...before, ...after], { propagate: false });
      return { added: added.sort(), changed: changed.sort(), removed: removed.sort(), stale };
    });
  }

  // ------------------------------------------------------------------- tags

  setTags(tags: readonly Tag[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO tags (node_id, question_id, answer, p, confidence, hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id, question_id) DO UPDATE SET
        answer = excluded.answer, p = excluded.p, confidence = excluded.confidence,
        hash = excluded.hash, updated_at = excluded.updated_at`);
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const t of tags) stmt.run(t.nodeId, t.questionId, t.answer, t.p, t.confidence, t.hash, now);
    });
  }

  setTag(tag: Tag): void {
    this.setTags([tag]);
  }

  getTag(nodeId: string, questionId: string): Tag | undefined {
    const r = this.db.prepare('SELECT * FROM tags WHERE node_id = ? AND question_id = ?').get(nodeId, questionId) as
      | Row
      | undefined;
    return r ? toTag(r) : undefined;
  }

  getTags(nodeId: string): Tag[] {
    return (this.db.prepare('SELECT * FROM tags WHERE node_id = ? ORDER BY question_id').all(nodeId) as Row[]).map(toTag);
  }

  tagsForQuestion(questionId: string): Tag[] {
    return (this.db.prepare('SELECT * FROM tags WHERE question_id = ? ORDER BY node_id').all(questionId) as Row[]).map(
      toTag,
    );
  }

  allTags(): Tag[] {
    return (this.db.prepare('SELECT * FROM tags ORDER BY node_id, question_id').all() as Row[]).map(toTag);
  }

  /** Distinct tag question ids in the store. */
  tagQuestionIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT question_id FROM tags ORDER BY question_id').all() as Row[]).map((r) =>
      String(r.question_id),
    );
  }

  /** Tags whose recorded hash no longer matches their node's current hash. */
  staleTags(): Tag[] {
    const rows = this.db
      .prepare(
        'SELECT t.* FROM tags t JOIN nodes n ON n.id = t.node_id WHERE t.hash <> n.hash ORDER BY t.node_id, t.question_id',
      )
      .all() as Row[];
    return rows.map(toTag);
  }

  deleteTags(nodeId: string, questionId?: string): void {
    if (questionId === undefined) this.db.prepare('DELETE FROM tags WHERE node_id = ?').run(nodeId);
    else this.db.prepare('DELETE FROM tags WHERE node_id = ? AND question_id = ?').run(nodeId, questionId);
  }
}

/** Epoch ms of the last full parse recorded in <storeDir>/graph.meta.json, or undefined. */
export function readIndexedAt(storeDir: string): number | undefined {
  try {
    const file = join(storeDir, META_FILE);
    assertNotSymlinkSync(file);
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { indexedAt?: unknown }).indexedAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Opens the store at <repoRoot>/.glassbox/graph.db. */
export function openStore(repoRoot: string): GraphStore {
  return GraphStore.open(repoRoot);
}
