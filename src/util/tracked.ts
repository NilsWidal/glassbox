import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STORE_DIR = '.glassbox';

function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return undefined;
  }
}

/**
 * True when the store directory <repoRoot>/.glassbox came with the repo
 * instead of being made in this checkout, so what is in it (config, graph)
 * was written by someone else. That is the case when:
 *
 * - git tracks anything under it, compared without case (a committed
 *   `.glassbox/CONFIG.json` is read as config.json on a case-insensitive
 *   file system);
 * - it is a git submodule or any other git checkout (a gitlink entry, a
 *   `.gitmodules` path, or its own `.git`), whose files the parent's index
 *   does not list.
 *
 * False outside a git repo or when git is missing, since then nothing can
 * have come with a clone.
 */
export function storeTrackedByGit(repoRoot: string): boolean {
  const dir = join(repoRoot, STORE_DIR);
  // A checkout of its own (submodule, nested clone) is never a store glassbox made.
  if (existsSync(join(dir, '.git'))) return true;
  try {
    const modules = readFileSync(join(repoRoot, '.gitmodules'), 'utf8');
    if (/^\s*path\s*=\s*\.glassbox\s*$/im.test(modules)) return true;
  } catch {
    // No .gitmodules.
  }
  // `icase` matches .glassbox, .GlassBox and everything under them; a gitlink shows up as the path itself.
  const listed = git(repoRoot, ['ls-files', '-z', '--', `:(icase)${STORE_DIR}`]);
  return listed !== undefined && listed.length > 0;
}
