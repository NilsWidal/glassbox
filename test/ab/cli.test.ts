import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../../bench/ab/src/cli.ts';
import type { ResultsFile } from '../../bench/ab/src/report.ts';
import { claudeStream, fakeProc, type FakeHandler } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-ab-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(handler: FakeHandler = () => undefined) {
  const out: string[] = [];
  const err: string[] = [];
  const { run, calls } = fakeProc(handler);
  const d: CliDeps = {
    run,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { PATH: process.env.PATH ?? '', HOME: dir, GLASSBOX_AB_CACHE: join(dir, 'cache') },
    now: () => new Date('2026-09-23T10:00:00Z'),
    tmpRoot: dir,
  };
  return { d, out, err, calls };
}

describe('ab cli', () => {
  it('lists the tasks', async () => {
    const { d, out } = deps();
    expect(await main(['list'], d)).toBe(0);
    expect(out.join('')).toMatch(/^\d+ tasks$/m);
    expect(out.join('')).toContain('fx-q-session-expiry');
  });

  it('prints command lines without running anything on --dry-run', async () => {
    const { d, out, calls } = deps();
    expect(await main(['run', '--tasks', 'fx-q-session-expiry', '--dry-run'], d)).toBe(0);
    const text = out.join('');
    expect(text).toContain('fx-q-session-expiry baseline: claude -p --output-format stream-json');
    expect(text).toMatch(/fx-q-session-expiry ambient: .*--plugin-dir /);
    expect(text).toContain('--model haiku');
    expect(calls).toEqual([]);
  });

  it('rejects unknown task ids and bad options', async () => {
    await expect(main(['run', '--tasks', 'nope', '--dry-run'], deps().d)).rejects.toThrow(/unknown task id/);
    await expect(main(['run', '--tasks', 'fx-q-session-expiry', '--arms', 'x'], deps().d)).rejects.toThrow(/--arms/);
    await expect(main(['run', '--tasks', 'fx-q-session-expiry', '--repeats', '0'], deps().d)).rejects.toThrow(/--repeats/);
  });

  it('runs a fixture task in both arms with a mocked agent and writes labeled results', async () => {
    const handler: FakeHandler = (req) => {
      if (req.args[0]?.endsWith('glassbox.mjs')) return { code: 0 };
      if (req.cmd === 'claude' && req.args[0] === '--version') return { stdout: '9.9.9 (Claude Code)\n' };
      if (req.cmd === 'claude') {
        const ambient = req.args.includes('--plugin-dir');
        return { stdout: claudeStream({ answer: ambient ? 'verifySession in src/auth/session.ts' : 'Probably somewhere in auth.', tools: ambient ? [] : ['Grep'] }) };
      }
      return undefined;
    };
    const { d, err } = deps(handler);
    const out = join(dir, 'results', 'pilot');
    const code = await main(['run', '--tasks', 'fx-q-session-expiry', '--label', 'pilot, small n', '--caveat', 'n=1', '--out', out], d);
    expect(code).toBe(0);
    expect(err.join('')).toContain('wrote');
    const json = JSON.parse(readFileSync(`${out}.json`, 'utf8')) as ResultsFile;
    expect(json).toMatchObject({ label: 'pilot, small n', date: '2026-09-23', agent: 'claude', model: 'haiku', agentVersion: '9.9.9 (Claude Code)', caveats: ['n=1'] });
    expect(json.runs.map((r) => [r.arm, r.success])).toEqual([
      ['baseline', false],
      ['ambient', true],
    ]);
    expect(json.summary.paired).toMatchObject({ tasks: 1, ambientOnlyPass: 1 });
    expect(existsSync(`${out}.md`)).toBe(true);
    expect(readFileSync(`${out}.md`, 'utf8')).toContain('# A/B results: pilot, small n');
  });
});
