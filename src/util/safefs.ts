import { constants, lstatSync, mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * Guards for files glassbox writes inside a repo. A cloned repo may commit
 * AGENTS.md or .glassbox/ as a symlink to somewhere like ~/.zshenv, so every
 * write refuses symlinks and paths that resolve outside the repo root.
 */

const GITIGNORE = '# Written by glassbox: decisions and the graph stay local.\n*\n';

export function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isSymlinkSync(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Throws when `path` is a symlink or its directory resolves outside `root`. */
export async function assertSafeTarget(root: string, path: string): Promise<void> {
  if (await isSymlink(path)) throw new Error(`refusing to use ${path}: it is a symlink`);
  const realRoot = await realpath(root);
  const realDir = await realpath(dirname(path));
  if (!within(realRoot, realDir)) throw new Error(`refusing to use ${path}: it resolves outside ${root}`);
}

/** Reads a file under root, or null when missing; refuses symlinks. */
export async function readInsideOrNull(root: string, path: string): Promise<string | null> {
  await assertSafeTarget(root, path);
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes via a temp file in the same directory plus rename, so a symlink is never written through. */
export async function writeInside(root: string, path: string, content: string): Promise<void> {
  await assertSafeTarget(root, path);
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.glassbox.tmp`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Appends to a file, refusing a symlinked file or directory. */
export async function appendNoFollow(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  if (await isSymlink(dir)) throw new Error(`refusing to write into ${dir}: it is a symlink`);
  const fh = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Creates <root>/<name> (the .glassbox store) as a real directory inside root,
 * with a .gitignore of `*` so logs that may hold diffs are not committed.
 */
export function ensureStoreDirSync(root: string, name: string): string {
  const dir = join(root, name);
  if (isSymlinkSync(dir)) throw new Error(`refusing to use ${dir}: it is a symlink`);
  mkdirSync(dir, { recursive: true });
  if (!within(realpathSync(root), realpathSync(dir))) throw new Error(`refusing to use ${dir}: it resolves outside ${root}`);
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore) && !isSymlinkSync(ignore)) {
    try {
      writeFileSync(ignore, GITIGNORE, { flag: 'wx' });
    } catch {
      // Best effort: a missing .gitignore must not block the store.
    }
  }
  return dir;
}

/** Throws when a file inside the store is a symlink (e.g. a committed graph.db link). */
export function assertNotSymlinkSync(path: string): void {
  if (isSymlinkSync(path)) throw new Error(`refusing to use ${path}: it is a symlink`);
}
