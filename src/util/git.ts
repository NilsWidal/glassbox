import { execFile } from 'node:child_process';

const MAX_BUFFER = 16 * 1024 * 1024;
/** Untracked files added to the diff; more than this are left out. */
const MAX_UNTRACKED = 50;

function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      if (!err || (typeof code === 'number' && okCodes.includes(code))) return ok(stdout);
      const first = String(stderr || err.message).split('\n').find((l) => l.trim()) ?? 'git failed';
      fail(new Error(first.trim()));
    });
  });
}

/**
 * Uncommitted changes against HEAD, plus new untracked files (not ignored) as
 * additions, so triage sees files that were just created.
 */
export async function workingDiff(cwd: string): Promise<string> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error('not a git repository; pass a diff (--diff <file>, or the diff argument)');
  }
  const tracked = await git(cwd, ['diff', 'HEAD']).catch(() => git(cwd, ['diff', '--cached']));
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const parts = [tracked];
  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    // --no-index exits 1 when the files differ, which is always the case here.
    parts.push(await git(cwd, ['diff', '--no-index', '--', '/dev/null', file], [0, 1]).catch(() => ''));
  }
  return parts.filter(Boolean).join('');
}
