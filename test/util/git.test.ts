import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workingDiff } from '../../src/util/git.js';

describe('workingDiff', () => {
  it('gives one short line outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-nogit-'));
    const err = await workingDiff(dir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('not a git repository; pass a diff (--diff <file>, or the diff argument)');
  });

  it('includes tracked changes and new untracked files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
    git('init', '-q');
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    git('add', 'a.ts');
    git('commit', '-qm', 'init');
    await writeFile(join(dir, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(dir, 'new.ts'), 'export const b = 3;\n');
    const diff = await workingDiff(dir);
    expect(diff).toContain('+export const a = 2;');
    expect(diff).toContain('+++ b/new.ts');
    expect(diff).toContain('+export const b = 3;');
  });
});
