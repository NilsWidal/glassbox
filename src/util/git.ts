import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS_HEADER, IMPORT_LINE, blockLineRange } from '../agents-md/sync.js';
import { SECRET_FILE } from '../scope.js';

const MAX_BUFFER = 16 * 1024 * 1024;
/** Untracked files added to the diff; more than this are left out. */
const MAX_UNTRACKED = 50;
const IMPORT_FORMS = new Set([IMPORT_LINE, '@./AGENTS.md']);

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
 * additions, so triage sees files that were just created. Left out:
 * untracked files that may hold secrets (.env, keys), changes that only touch
 * the glassbox block in AGENTS.md, and a CLAUDE.md change that only adds the
 * `@AGENTS.md` import, since glassbox wrote those itself.
 */
export async function workingDiff(cwd: string): Promise<string> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error('not a git repository; pass a diff (--diff <file>, or the diff argument)');
  }
  const tracked = await git(cwd, ['diff', 'HEAD']).catch(() => git(cwd, ['diff', '--cached']));
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((f) => f && !SECRET_FILE.test(f));
  const parts = [tracked];
  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    // --no-index exits 1 when the files differ, which is always the case here.
    parts.push(await git(cwd, ['diff', '--no-index', '--', '/dev/null', file], [0, 1]).catch(() => ''));
  }
  return withoutGlassboxChanges(parts.filter(Boolean).join(''), {
    head: (file) => git(cwd, ['show', `HEAD:${file}`]).catch(() => null),
    work: (file) => readFile(join(cwd, file), 'utf8').catch(() => null),
  });
}

/** One file's part of a unified diff: from its `diff --git` line to the next. */
export interface DiffSection {
  text: string;
  /** New path (old path for a deletion), without the a/ or b/ prefix. */
  path: string | undefined;
}

/** Splits a diff into per-file sections. Text before the first `diff --git` line is its own section. */
export function splitDiff(diff: string): DiffSection[] {
  const out: DiffSection[] = [];
  const re = /^diff --git /gm;
  const starts: number[] = [];
  for (let m = re.exec(diff); m; m = re.exec(diff)) starts.push(m.index);
  if (starts.length === 0 || starts[0]! > 0) starts.unshift(0);
  starts.forEach((s, i) => {
    const text = diff.slice(s, starts[i + 1] ?? diff.length);
    if (text) out.push({ text, path: sectionPath(text) });
  });
  return out;
}

function sectionPath(text: string): string | undefined {
  const plus = /^\+\+\+ (?:b\/)?(.+?)\t?$/m.exec(text)?.[1];
  if (plus && plus !== '/dev/null') return plus.trim();
  const minus = /^--- (?:a\/)?(.+?)\t?$/m.exec(text)?.[1];
  if (minus && minus !== '/dev/null') return minus.trim();
  const renameTo = /^rename to (.+)$/m.exec(text)?.[1];
  if (renameTo) return renameTo.trim();
  return /^diff --git a\/(\S+) b\/(\S+)/.exec(text)?.[2];
}

interface FileReaders {
  /** Content at HEAD, or null when the file is not there. */
  head: (file: string) => Promise<string | null>;
  /** Content in the working tree, or null when missing. */
  work: (file: string) => Promise<string | null>;
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Lines of `text` outside the glassbox block, blank runs collapsed, trimmed. */
function outsideBlock(text: string): string {
  const lines = normalize(text).split('\n');
  const range = blockLineRange(text);
  const kept = range ? [...lines.slice(0, range.start - 1), ...lines.slice(range.end)] : lines;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function withoutImport(text: string): string {
  return normalize(text)
    .split('\n')
    .filter((l) => !IMPORT_FORMS.has(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Drops the hunks of an AGENTS.md section whose changed lines all fall inside
 * the glassbox block (old lines in the old block, new lines in the new one).
 * Returns undefined when no hunk is left.
 */
function dropBlockHunks(text: string, oldRange?: { start: number; end: number }, newRange?: { start: number; end: number }): string | undefined {
  const inOld = (n: number) => Boolean(oldRange && n >= oldRange.start && n <= oldRange.end);
  const inNew = (n: number) => Boolean(newRange && n >= newRange.start && n <= newRange.end);
  const lines = text.split('\n');
  const header: string[] = [];
  const hunks: { lines: string[]; ours: boolean }[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunks.push({ lines: [line], ours: true });
      continue;
    }
    const hunk = hunks[hunks.length - 1];
    if (!hunk) {
      header.push(line);
      continue;
    }
    hunk.lines.push(line);
    if (line.startsWith('-')) {
      if (!inOld(oldNo)) hunk.ours = false;
      oldNo++;
    } else if (line.startsWith('+')) {
      if (!inNew(newNo)) hunk.ours = false;
      newNo++;
    } else if (line.startsWith(' ')) {
      oldNo++;
      newNo++;
    }
  }
  const kept = hunks.filter((h) => !h.ours);
  if (kept.length === 0) return undefined;
  if (kept.length === hunks.length) return text;
  const res = [...header, ...kept.flatMap((h) => h.lines)].join('\n');
  return res.endsWith('\n') ? res : `${res}\n`;
}

/**
 * Removes what glassbox itself wrote from a working-tree diff: AGENTS.md hunks
 * inside the glassbox block (a new AGENTS.md that holds only the block and the
 * standard header), and a CLAUDE.md change that only adds the `@AGENTS.md` import.
 * Only the repo-root files are considered.
 */
export async function withoutGlassboxChanges(diff: string, files: FileReaders): Promise<string> {
  const out: string[] = [];
  for (const section of splitDiff(diff)) {
    if (section.path === 'CLAUDE.md') {
      const [before, after] = await Promise.all([files.head('CLAUDE.md'), files.work('CLAUDE.md')]);
      if (after !== null && withoutImport(before ?? '') === withoutImport(after)) continue;
    } else if (section.path === 'AGENTS.md') {
      const [before, after] = await Promise.all([files.head('AGENTS.md'), files.work('AGENTS.md')]);
      if (after !== null) {
        const base = before === null ? outsideBlock(AGENTS_HEADER) : outsideBlock(before);
        const now = outsideBlock(after);
        if (now === base || (before === null && now === '')) continue;
        const kept = dropBlockHunks(section.text, before === null ? undefined : blockLineRange(before), blockLineRange(after));
        if (kept === undefined) continue;
        out.push(kept);
        continue;
      }
    }
    out.push(section.text);
  }
  return out.join('');
}
