import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScope, chunkDiff, chunkText, renderState, spanLabel } from '../src/scope.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'sample-repo');

describe('chunkText', () => {
  it('splits on blank lines and windows long groups', () => {
    const text = ['a', 'b', '', '', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const chunks = chunkText('x.ts', text, { maxLines: 3 });
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 2],
      [5, 7],
      [8, 9],
    ]);
    expect(chunks[1]!.text).toBe('c\nd\ne');
  });

  it('offsets line numbers for node slices', () => {
    const chunks = chunkText('x.ts', 'a\nb', { firstLine: 40 });
    expect(chunks[0]).toMatchObject({ startLine: 40, endLine: 41 });
  });
});

describe('chunkDiff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,4 +10,4 @@ function f() {',
    ' const a = 1;',
    '-const ttl = 60;',
    '+const ttl = Number(process.env.TTL);',
    ' return a;',
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-export const x = 1;',
    '--- not a header, a removed line',
  ].join('\n');

  it('maps hunks to new-file line numbers', () => {
    const chunks = chunkDiff(diff);
    expect(chunks[0]).toMatchObject({ file: 'src/a.ts', startLine: 10, endLine: 12, diff: true });
    expect(chunks[0]!.text).toContain('+const ttl = Number(process.env.TTL);');
  });

  it('keeps deleted files under their old path and old lines', () => {
    const gone = chunkDiff(diff).find((c) => c.file === 'src/gone.ts')!;
    expect(gone).toMatchObject({ startLine: 1, endLine: 2 });
    expect(gone.text).toContain('--- not a header');
  });
});

describe('buildScope', () => {
  it('reads files into chunks with enclosing node ids', async () => {
    const { chunks } = await buildScope({ paths: ['src/auth/session.ts'] }, { root: FIXTURE });
    const verify = chunks.find((c) => c.text.includes('session.expiresAt < Date.now()'))!;
    expect(verify.nodeId).toBe('src/auth/session.ts#verifySession');
    expect(renderState(chunks)).toContain(`### ${spanLabel(verify.file, verify.startLine, verify.endLine)}`);
  });

  it('expands directories and node ids', async () => {
    const dir = await buildScope({ paths: ['src/auth'] }, { root: FIXTURE });
    expect(new Set(dir.chunks.map((c) => c.file))).toEqual(new Set(['src/auth/middleware.ts', 'src/auth/password.ts', 'src/auth/session.ts']));
    const node = await buildScope({ nodes: ['src/auth/session.ts#verifySession'] }, { root: FIXTURE });
    expect(node.chunks[0]!.startLine).toBe(38);
    expect(node.chunks.at(-1)!.endLine).toBe(46);
  });

  it('rejects empty, oversized, unknown and outside scopes', async () => {
    await expect(buildScope({}, { root: FIXTURE })).rejects.toThrow(/empty/);
    await expect(buildScope({ paths: ['src'] }, { root: FIXTURE, maxChars: 100 })).rejects.toThrow(/too large/);
    await expect(buildScope({ nodes: ['src/db.ts#nope'] }, { root: FIXTURE })).rejects.toThrow(/unknown node/);
    await expect(buildScope({ paths: ['../x'] }, { root: FIXTURE })).rejects.toThrow(/outside/);
  });

  it('dedupes a node that is also inside a listed file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glassbox-scope-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/f.ts'), 'export function f() {\n  return 1;\n}\n');
    const { chunks } = await buildScope({ paths: ['src/f.ts'], nodes: ['src/f.ts#f'] }, { root });
    expect(chunks).toHaveLength(1);
  });
});
