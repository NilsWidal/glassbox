import { execFileSync } from 'node:child_process';

/**
 * True when git tracks `file` in the repo at `repoRoot`, i.e. it came with the
 * repo (someone else wrote it) instead of being made in this checkout. False
 * outside a git repo, when git is missing, or when the check fails.
 */
export function trackedByGit(repoRoot: string, file: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: repoRoot, stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
