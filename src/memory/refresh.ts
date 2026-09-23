import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { safePath } from '../agents-md/render.js';
import { syncAgentsMd } from '../agents-md/sync.js';
import type { SyncAgentsMdResult } from '../agents-md/types.js';
import type { Backend } from '../types.js';
import { indexRepo } from './source.js';
import { STORE_DIR } from '../ask.js';
import type { GraphStore, SyncResult } from './store.js';
import { buildAgentsSummary } from './summary.js';
import { tagPass, type TagPassResult } from './tags.js';

// Same as store.ts STORE_FILE; kept local so importing this module never loads node:sqlite.
const STORE_FILE = 'graph.db';

export interface RefreshOptions {
  /**
   * Only mark the nodes of these files (and their one-hop dependents) stale.
   * No parsing and no model calls, so it is fast enough for an edit hook.
   */
  files?: readonly string[];
  /** Repo mode: re-ask tags for stale nodes afterwards. Needs `backend`. */
  tags?: boolean;
  backend?: () => Backend;
  /** Repo mode: most nodes re-tagged now; the rest stay stale. */
  limit?: number;
  /** Rewrite the AGENTS.md block afterwards. claudeMd false never creates CLAUDE.md. */
  syncMd?: boolean | { claudeMd?: boolean };
}

export interface RefreshResult {
  /** False when the repo has no glassbox graph yet; nothing was done or created. */
  indexed: boolean;
  mode: 'files' | 'repo';
  /** Node ids now marked stale. */
  stale: string[];
  /** Files mode: given files the graph does not know (new, deleted or unsupported). */
  unknownFiles?: string[];
  sync?: SyncResult;
  tags?: TagPassResult;
  md?: SyncAgentsMdResult;
}

/** True when the repo has a glassbox graph (created by `glassbox init` or `index`). */
export function hasGraph(root: string): boolean {
  return existsSync(join(root, STORE_DIR, STORE_FILE));
}

/** A path as the graph stores it: POSIX, relative to the root. Undefined when outside the root. */
export function graphPath(root: string, file: string): string | undefined {
  const rel = isAbsolute(file) ? relative(root, file) : file;
  const posix = rel.split(sep).join('/').replace(/^\.\//, '');
  if (!posix || posix.startsWith('../') || posix === '..' || isAbsolute(posix)) return undefined;
  return posix;
}

/**
 * Brings the stored graph up to date. With `files`, only marks those files'
 * nodes stale (the edit-hook path). Without, re-parses the repo (incremental by
 * content hash), then optionally re-tags stale nodes and rewrites AGENTS.md.
 * Never creates .glassbox/ in a repo that has none.
 */
export async function refresh(root: string, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const mode = opts.files ? 'files' : 'repo';
  if (!hasGraph(root)) return { indexed: false, mode, stale: [] };
  const { GraphStore } = await import('./store.js');
  const store: GraphStore = GraphStore.open(root);
  try {
    const result: RefreshResult = { indexed: true, mode, stale: [] };
    if (opts.files) {
      const ids: string[] = [];
      const unknown: string[] = [];
      for (const f of opts.files) {
        const p = graphPath(root, f);
        const nodes = p ? store.getNodes({ file: p }) : [];
        if (nodes.length === 0) unknown.push(p ?? f);
        else ids.push(...nodes.map((n) => n.id));
      }
      result.stale = ids.length ? store.markStale(ids) : [];
      if (unknown.length) result.unknownFiles = unknown;
    } else {
      const { sync } = await indexRepo(root, store);
      result.sync = sync;
      result.stale = sync.stale;
      if (opts.tags) {
        if (!opts.backend) throw new Error('re-tagging needs a backend');
        result.tags = await tagPass(root, opts.backend(), { store, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
      }
    }
    if (opts.syncMd) {
      const claudeMd = typeof opts.syncMd === 'object' ? opts.syncMd.claudeMd !== false : true;
      result.md = await syncAgentsMd(root, buildAgentsSummary(store), { claudeMd });
    }
    return result;
  } finally {
    store.close();
  }
}

/** One-line report for the CLI and the MCP tool. */
export function renderRefresh(r: RefreshResult): string {
  if (!r.indexed) return 'no glassbox graph here yet (run `glassbox init`); nothing to refresh';
  const out: string[] = [];
  if (r.mode === 'files') {
    out.push(`stale  ${r.stale.length} node${r.stale.length === 1 ? '' : 's'} marked (re-tagged on the next \`glassbox index\`)`);
    if (r.unknownFiles?.length) out.push(`unknown  ${r.unknownFiles.map(safePath).join(', ')} (picked up by the next full refresh)`);
  } else if (r.sync) {
    const s = r.sync;
    out.push(`graph  +${s.added.length} ~${s.changed.length} -${s.removed.length}, ${s.stale.length} stale`);
  }
  if (r.tags) out.push(`tags   ${r.tags.asked} nodes asked, ${r.tags.cached} cached${r.tags.deferred ? `, ${r.tags.deferred} deferred` : ''}`);
  if (r.md) out.push(`sync   AGENTS.md ${r.md.agentsMd}, CLAUDE.md ${r.md.claudeMd}`);
  return out.join('\n');
}
