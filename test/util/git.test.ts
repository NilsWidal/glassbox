import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncAgentsMd, type AgentsMdSummary } from '../../src/agents-md/index.js';
import { chunkDiff } from '../../src/scope.js';
import { dropBlockLines, withoutGlassboxChanges, workingDiff } from '../../src/util/git.js';

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

describe('workingDiff filtering', () => {
  async function repo() {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    return { dir, git };
  }

  it('leaves out untracked files that may hold secrets', async () => {
    const { dir, git } = await repo();
    git('add', 'a.ts');
    git('commit', '-qm', 'init');
    await writeFile(join(dir, '.env'), 'API_KEY=sk-live-123\n');
    await writeFile(join(dir, 'deploy.pem'), 'PRIVATE\n');
    await writeFile(join(dir, 'b.ts'), 'export const b = 1;\n');
    const diff = await workingDiff(dir);
    expect(diff).toContain('+++ b/b.ts');
    expect(diff).not.toContain('sk-live-123');
    expect(diff).not.toContain('deploy.pem');
  });

  it('drops the glassbox AGENTS.md block and a CLAUDE.md that only holds the import', async () => {
    const { dir, git } = await repo();
    git('add', 'a.ts');
    git('commit', '-qm', 'init');
    // What `glassbox init` writes into a repo without either file.
    await syncAgentsMd(dir, summary);
    expect(await workingDiff(dir)).toBe('');
    git('add', '-A');
    git('commit', '-qm', 'glassbox');

    // A later block rewrite is left out, but the user's own edit and the code change stay.
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    await writeFile(
      join(dir, 'AGENTS.md'),
      `${agents.replace('**auth**', '**authn**').replace('# AGENTS.md\n', '# AGENTS.md\n\nRun npm test before committing.\n')}`,
    );
    await writeFile(join(dir, 'a.ts'), 'export const a = 2;\n');
    const diff = await workingDiff(dir);
    expect(diff).toContain('+Run npm test before committing.');
    expect(diff).not.toContain('authn');
    expect(diff).toContain('+export const a = 2;');
    expect(chunkDiff(diff).map((c) => c.file)).toEqual(['AGENTS.md', 'a.ts']);
  });

  it('filters block changes line by line, even when a user edit sits next to the block', async () => {
    const { dir, git } = await repo();
    await writeFile(join(dir, 'AGENTS.md'), '# AGENTS.md\n\nIntro line.\n');
    await syncAgentsMd(dir, summary);
    git('add', '-A');
    git('commit', '-qm', 'init');
    const before = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    // The user edit is 2 lines above the start marker, so git puts it in the same hunk as the block change.
    await writeFile(join(dir, 'AGENTS.md'), before.replace('Intro line.', 'Intro line, edited.').replace('**auth**', '**authn**'));
    const diff = await workingDiff(dir);
    expect(diff).toContain('+Intro line, edited.');
    expect(diff).toContain('-Intro line.');
    expect(diff).not.toContain('authn');
    expect(diff).not.toContain('glassbox:start');
    const chunks = chunkDiff(diff);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ file: 'AGENTS.md', changedLines: [3] });
    // The start marker is on line 5; nothing from the block is left in the chunk.
    expect(chunks[0]!.endLine).toBeLessThan(5);
  });

  it('keeps an import added next to other CLAUDE.md edits', async () => {
    const { dir, git } = await repo();
    await writeFile(join(dir, 'CLAUDE.md'), 'Be terse.\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await writeFile(join(dir, 'CLAUDE.md'), 'Be terse.\n\n@AGENTS.md\n');
    expect(await workingDiff(dir)).toBe('');
    await writeFile(join(dir, 'CLAUDE.md'), 'Be brief.\n\n@AGENTS.md\n');
    expect(await workingDiff(dir)).toContain('+Be brief.');
  });

  it('shows a staged move as a rename that chunks to the old path', async () => {
    const { dir, git } = await repo();
    git('add', 'a.ts');
    git('commit', '-qm', 'init');
    git('mv', 'a.ts', 'moved.ts');
    const chunks = chunkDiff(await workingDiff(dir));
    expect(chunks).toEqual([expect.objectContaining({ file: 'moved.ts', renamedFrom: 'a.ts', renameOnly: true })]);
  });
});

describe('dropBlockLines', () => {
  it('drops block lines, keeps user lines with fresh hunk headers, and drops hunks left with only context', () => {
    const section = [
      'diff --git a/AGENTS.md b/AGENTS.md',
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1,6 +1,6 @@',
      '-user old',
      '+user new',
      ' ctx',
      ' <!-- glassbox:start -->',
      '-block old',
      '+block new',
      ' <!-- glassbox:end -->',
      ' tail',
      '',
    ].join('\n');
    const out = dropBlockLines(section, { start: 3, end: 5 }, { start: 3, end: 5 });
    expect(out).toBe(['diff --git a/AGENTS.md b/AGENTS.md', '--- a/AGENTS.md', '+++ b/AGENTS.md', '@@ -1,2 +1,2 @@', '-user old', '+user new', ' ctx', ''].join('\n'));
    expect(dropBlockLines(section, { start: 1, end: 30 }, { start: 1, end: 30 })).toBeUndefined();
  });
});

describe('withoutGlassboxChanges', () => {
  it('keeps text before the first diff header and unrelated files untouched', async () => {
    const diff = 'preamble\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const out = await withoutGlassboxChanges(diff, { head: async () => null, work: async () => null });
    expect(out).toBe(diff);
  });
});

const summary: AgentsMdSummary = {
  areas: [{ name: 'auth', entryPoints: ['src/auth/session.ts:42'], nodeCount: 2 }],
  riskyNodes: [],
  availableTags: ['io'],
  generatedAt: '2026-09-22T10:00:00.000Z',
};
