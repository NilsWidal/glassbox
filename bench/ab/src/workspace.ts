// Repo sources, fresh workspaces and file edits for the A/B harness.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { RunProc } from './proc.ts';
import type { Replace, Repo, Task } from './tasks.ts';

/**
 * Names never copied into a workspace, at any depth: VCS and build folders, and the repo's
 * own agent settings. A repo's `.claude/` (hooks run as shell commands, permission lists),
 * `.mcp.json`, `.codex/` and `CLAUDE.local.md` would otherwise configure the agent under test.
 */
export const SKIP_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.glassbox',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  '.claude',
  '.mcp.json',
  '.codex',
  'CLAUDE.local.md',
]);

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GLASSBOX_AB_CACHE ? resolve(env.GLASSBOX_AB_CACHE) : join(homedir(), '.cache', 'glassbox-ab');
}

/** Copies a tree, keeping file times (the glassbox graph compares them), without SKIP_NAMES. */
export function copyTree(src: string, dst: string, opts: { keepGlassbox?: boolean } = {}): void {
  cpSync(src, dst, {
    recursive: true,
    preserveTimestamps: true,
    filter: (p) => {
      if (p === src) return true;
      const name = basename(p);
      if (name === '.glassbox') return opts.keepGlassbox === true;
      return !SKIP_NAMES.has(name);
    },
  });
}

async function git(run: RunProc, cwd: string, args: string[], timeoutMs = 300_000): Promise<string> {
  const r = await run({
    cmd: 'git',
    args,
    cwd,
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.spawnError ?? r.stderr).trim()}`);
  return r.stdout.trim();
}

/**
 * Returns a local directory holding the repo at its pinned state. A path repo is used in
 * place. A git repo is cloned once into `cacheDir/repos/<name>` and checked out at its
 * commit; the checkout is verified, so a moved branch can never change what runs.
 */
export async function ensureRepo(name: string, repo: Repo, baseDir: string, cacheDir: string, run: RunProc): Promise<string> {
  if (repo.type === 'path') {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(baseDir, repo.path);
    if (!existsSync(dir)) throw new Error(`repo ${name}: ${dir} does not exist`);
    return dir;
  }
  const dir = join(cacheDir, 'repos', name);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(cacheDir, 'repos'), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    await git(run, join(cacheDir, 'repos'), ['clone', '--quiet', '--no-checkout', repo.url, name]);
  }
  const head = await git(run, dir, ['rev-parse', 'HEAD']).catch(() => '');
  if (head !== repo.commit) {
    const has = await git(run, dir, ['cat-file', '-e', `${repo.commit}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!has) await git(run, dir, ['fetch', '--quiet', 'origin', repo.commit]);
    await git(run, dir, ['checkout', '--quiet', '--force', repo.commit]);
  }
  await git(run, dir, ['reset', '--quiet', '--hard']);
  await git(run, dir, ['clean', '-fdxq']);
  const now = await git(run, dir, ['rev-parse', 'HEAD']);
  if (now !== repo.commit) throw new Error(`repo ${name}: expected ${repo.commit}, got ${now}`);
  return dir;
}

/** Applies exact, single-occurrence text replacements. Throws when a `find` is missing or ambiguous. */
export function applyReplacements(root: string, edits: Replace[]): void {
  for (const e of edits) {
    const file = join(root, e.file);
    const text = readFileSync(file, 'utf8');
    const first = text.indexOf(e.find);
    if (first < 0) throw new Error(`${e.file}: text to replace not found: ${JSON.stringify(e.find.slice(0, 80))}`);
    if (text.indexOf(e.find, first + 1) >= 0) throw new Error(`${e.file}: text to replace occurs more than once`);
    writeFileSync(file, text.slice(0, first) + e.replace + text.slice(first + e.find.length));
  }
}

/** Puts protected paths back to their content in `from`, removing anything the agent added there. */
export function restoreProtected(workspace: string, from: string, paths: string[]): void {
  for (const p of paths) {
    const dst = join(workspace, p);
    const src = join(from, p);
    rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) copyTree(src, dst);
  }
}

/** Makes the workspace a one-commit git repo, so the agent sees a clean tree and diffs work. */
export async function gitSnapshot(dir: string, run: RunProc): Promise<void> {
  await git(run, dir, ['init', '--quiet']);
  await git(run, dir, ['add', '-A']);
  await git(run, dir, [
    '-c',
    'user.name=glassbox-ab',
    '-c',
    'user.email=ab@glassbox.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'task start',
  ]);
}

export function taskSetupFiles(task: Task): string[] {
  return [...new Set((task.setup ?? []).map((s) => s.file))];
}
