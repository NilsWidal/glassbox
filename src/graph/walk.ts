import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { grammarFor } from './languages.js';

/** Directories never indexed, whatever .gitignore says. */
export const ALWAYS_SKIP = new Set(['node_modules', 'dist', '.glassbox', '.git', '__pycache__', '.venv', 'venv']);

export interface WalkOptions {
  /** Extra gitignore-style patterns, relative to the root. */
  ignore?: string[];
}

interface Scope {
  /** Directory of the .gitignore, relative to root ('' for the root). */
  dir: string;
  ig: Ignore;
}

async function loadGitignore(absDir: string, dir: string): Promise<Scope | null> {
  try {
    const text = await readFile(join(absDir, '.gitignore'), 'utf8');
    return { dir, ig: ignore().add(text) };
  } catch {
    return null;
  }
}

function ignored(scopes: Scope[], rel: string, isDir: boolean): boolean {
  for (const s of scopes) {
    const sub = s.dir ? rel.slice(s.dir.length + 1) : rel;
    if (s.ig.ignores(isDir ? `${sub}/` : sub)) return true;
  }
  return false;
}

/**
 * Lists parseable source files under `root` as sorted POSIX paths relative to
 * it. Honors nested .gitignore files and skips ALWAYS_SKIP and symlinks.
 */
export async function walkRepo(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const out: string[] = [];
  const base: Scope[] = [];
  if (opts.ignore?.length) base.push({ dir: '', ig: ignore().add(opts.ignore) });

  async function visit(dir: string, scopes: Scope[]): Promise<void> {
    const abs = dir ? join(root, dir) : root;
    const own = await loadGitignore(abs, dir);
    const active = own ? [...scopes, own] : scopes;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const rel = dir ? posix.join(dir, e.name) : e.name;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || ignored(active, rel, true)) continue;
        await visit(rel, active);
      } else if (e.isFile()) {
        if (!grammarFor(e.name) || ignored(active, rel, false)) continue;
        out.push(rel);
      }
    }
  }

  await visit('', base);
  return out.sort();
}
