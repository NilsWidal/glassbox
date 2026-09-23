import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTaskSet, parseTaskSet, referenceFix, safeRelative, selectTasks } from '../../bench/ab/src/tasks.ts';
import { AB } from './helpers.ts';

const minimal = (tasks: unknown[], repos: unknown = { r: { type: 'path', path: '.', license: 'MIT' } }) => ({ repos, tasks });
const q = (id: string, extra: object = {}) => ({
  id,
  repo: 'r',
  kind: 'question',
  prompt: 'p',
  checks: [{ type: 'answer', pattern: 'x' }],
  ...extra,
});

describe('bench/ab/tasks.json', () => {
  const set = loadTaskSet(join(AB, 'tasks.json'));

  it('ships at least 20 tasks over the fixture and pinned OSS repos', () => {
    expect(set.tasks.length).toBeGreaterThanOrEqual(20);
    const repos = new Set(set.tasks.map((t) => t.repo));
    expect(repos.has('fixture')).toBe(true);
    const git = Object.entries(set.repos).filter(([, r]) => r.type === 'git');
    expect(git.length).toBeGreaterThanOrEqual(1);
    expect(git.length).toBeLessThanOrEqual(2);
    for (const [, r] of git) {
      expect(r.type === 'git' && /^[0-9a-f]{40}$/.test(r.commit)).toBe(true);
      expect(r.license).toMatch(/^(MIT|Apache-2\.0)/);
    }
    for (const t of set.tasks) expect(set.repos[t.repo]).toBeDefined();
  });

  it('marks 6 pilot tasks, with both questions and code changes', () => {
    const pilot = selectTasks(set, { pilot: true });
    expect(pilot).toHaveLength(6);
    expect(pilot.some((t) => t.kind === 'question')).toBe(true);
    expect(pilot.some((t) => t.kind !== 'question')).toBe(true);
  });

  it('points every command check at a script that exists', () => {
    for (const t of set.tasks) {
      for (const c of t.checks) {
        if (c.type !== 'command') continue;
        for (const a of c.argv.filter((x) => x.startsWith('{checks}/'))) {
          expect(existsSync(a.replace('{checks}', join(AB, 'checks'))), `${t.id}: ${a}`).toBe(true);
        }
      }
    }
  });

  it('gives every code task a way to validate it', () => {
    for (const t of set.tasks) {
      if (t.kind === 'question') expect(t.referenceAnswer, t.id).toBeTruthy();
      else expect(referenceFix(t).length, t.id).toBeGreaterThan(0);
      if (t.setup?.length) expect(t.protect?.length, `${t.id} should protect its tests`).toBeGreaterThan(0);
    }
  });
});

describe('parseTaskSet', () => {
  it('accepts a minimal file', () => {
    expect(parseTaskSet(minimal([q('a')]), '/x').tasks).toHaveLength(1);
  });

  it('rejects duplicate ids, unknown repos, bad patterns and paths that leave the repo', () => {
    const bad = minimal([
      q('a'),
      q('a'),
      q('b', { repo: 'nope' }),
      q('c', { checks: [{ type: 'answer', pattern: '(' }] }),
      q('d', { kind: 'bugfix', setup: [{ file: '../etc/passwd', find: 'a', replace: 'b' }] }),
      q('e', { kind: 'edit', checks: [{ type: 'command', argv: ['true'] }], protect: ['/abs'] }),
    ]);
    let msg = '';
    try {
      parseTaskSet(bad, '/x');
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('a: duplicate id');
    expect(msg).toContain('b: unknown repo');
    expect(msg).toContain('c: bad pattern');
    expect(msg).toContain('d: path must stay inside the repo: ../etc/passwd');
    expect(msg).toContain('e: path must stay inside the repo: /abs');
  });

  it('requires an answer check on questions and a bug on bugfix tasks', () => {
    expect(() => parseTaskSet(minimal([q('a', { checks: [{ type: 'command', argv: ['true'] }] })]), '/x')).toThrow(/needs an answer check/);
    expect(() => parseTaskSet(minimal([q('a', { kind: 'bugfix' })]), '/x')).toThrow(/needs setup/);
  });

  it('rejects unpinned git repos and non-https urls', () => {
    const repos = { r: { type: 'git', url: 'https://example.com/x', commit: 'main', license: 'MIT' } };
    expect(() => parseTaskSet(minimal([q('a')], repos), '/x')).toThrow(/commit/);
    const repos2 = { r: { type: 'git', url: 'git@github.com:x/y', commit: 'a'.repeat(40), license: 'MIT' } };
    expect(() => parseTaskSet(minimal([q('a')], repos2), '/x')).toThrow(/url/);
  });
});

describe('selectTasks and referenceFix', () => {
  const set = parseTaskSet(minimal([q('a', { pilot: true }), q('b'), q('c', { pilot: true })]), '/x');

  it('selects by id in the given order, by pilot flag, or all', () => {
    expect(selectTasks(set, { ids: ['c', 'a'] }).map((t) => t.id)).toEqual(['c', 'a']);
    expect(selectTasks(set, { pilot: true }).map((t) => t.id)).toEqual(['a', 'c']);
    expect(selectTasks(set, {}).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(() => selectTasks(set, { ids: ['a', 'zz'] })).toThrow(/unknown task id\(s\): zz/);
  });

  it('reverses a bugfix setup when there is no solution', () => {
    const fix = referenceFix({
      id: 'x',
      repo: 'r',
      kind: 'bugfix',
      prompt: 'p',
      checks: [{ type: 'command', argv: ['true'] }],
      setup: [
        { file: 'a', find: '1', replace: '2' },
        { file: 'b', find: '3', replace: '4' },
      ],
    });
    expect(fix).toEqual([
      { file: 'b', find: '4', replace: '3' },
      { file: 'a', find: '2', replace: '1' },
    ]);
  });

  it('knows which relative paths are safe', () => {
    expect(safeRelative('src/a.py')).toBe(true);
    expect(safeRelative('tests')).toBe(true);
    for (const p of ['../x', 'a/../../x', '/etc', 'a//b', 'a\\b', '']) expect(safeRelative(p), p).toBe(false);
  });
});
