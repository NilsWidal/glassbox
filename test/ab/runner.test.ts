import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcRequest } from '../../bench/ab/src/proc.ts';
import { runProc } from '../../bench/ab/src/proc.ts';
import { copyTree } from '../../bench/ab/src/workspace.ts';
import { armOrder, runAll, validateTasks, type RunConfig } from '../../bench/ab/src/runner.ts';
import { loadTaskSet, parseTaskSet, selectTasks } from '../../bench/ab/src/tasks.ts';
import { AB, claudeStream, fakeProc } from './helpers.ts';

let dir: string;
let repo: string;
let tmpRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-ab-test-'));
  repo = join(dir, 'repo');
  tmpRoot = join(dir, 'tmp');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  mkdirSync(tmpRoot);
  writeFileSync(join(repo, 'a.txt'), 'ok\n');
  writeFileSync(join(repo, 'tests', 't.txt'), 'original\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CHECK = "const f=require('fs');process.exit(f.readFileSync('a.txt','utf8').includes('ok')&&f.readFileSync('tests/t.txt','utf8')==='original\\n'?0:1)";

function taskSet() {
  return parseTaskSet(
    {
      repos: { r: { type: 'path', path: 'repo', license: 'MIT' } },
      tasks: [
        { id: 'q1', repo: 'r', kind: 'question', prompt: 'is it?', checks: [{ type: 'answer', pattern: '^yes', flags: 'i' }] },
        {
          id: 'e1',
          repo: 'r',
          kind: 'bugfix',
          prompt: 'fix a.txt',
          setup: [{ file: 'a.txt', find: 'ok', replace: 'bug' }],
          protect: ['tests'],
          checks: [{ type: 'command', argv: [process.execPath, '-e', CHECK] }],
        },
      ],
    },
    dir,
  );
}

function config(extra: Partial<RunConfig> = {}): RunConfig {
  const set = taskSet();
  return {
    set,
    tasks: set.tasks,
    agent: 'claude',
    arms: ['baseline', 'ambient'],
    repeats: 1,
    model: 'haiku',
    pluginDir: '/glassbox',
    checksDir: join(AB, 'checks'),
    cacheDir: join(dir, 'cache'),
    timeoutSec: 30,
    initTags: true,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
    ...extra,
  };
}

interface Seen {
  arm: string;
  prompt: string;
  hadGlassbox: boolean;
  aTxt: string;
  gitClean: boolean;
}

function agentHandler(seen: Seen[], opts: { initFails?: boolean } = {}) {
  const inits: string[][] = [];
  const handler = (req: ProcRequest) => {
    if (req.cmd === process.execPath && req.args[0]?.endsWith('glassbox.mjs')) {
      inits.push(req.args);
      if (opts.initFails) return { code: 1, stderr: 'no backend' };
      const root = req.args[req.args.indexOf('--root') + 1] as string;
      mkdirSync(join(root, '.glassbox'), { recursive: true });
      writeFileSync(join(root, '.glassbox', 'graph.db'), 'db');
      writeFileSync(join(root, '.glassbox', '.gitignore'), '*\n');
      writeFileSync(join(root, 'AGENTS.md'), 'glassbox block\n');
      return { code: 0 };
    }
    if (req.cmd !== 'claude') return undefined;
    const arm = req.args.includes('--plugin-dir') ? 'ambient' : 'baseline';
    const git = readFileSync(join(req.cwd, '.git', 'HEAD'), 'utf8');
    seen.push({ arm, prompt: req.stdin ?? '', hadGlassbox: existsSync(join(req.cwd, '.glassbox')), aTxt: readFileSync(join(req.cwd, 'a.txt'), 'utf8'), gitClean: git.length > 0 });
    if (req.stdin === 'fix a.txt') {
      writeFileSync(join(req.cwd, 'a.txt'), 'ok\n');
      // The baseline also "fixes" the test; the harness must undo that before checking.
      if (arm === 'baseline') writeFileSync(join(req.cwd, 'tests', 't.txt'), 'hacked\n');
      return { stdout: claudeStream({ answer: 'Fixed a.txt.', tools: ['Read', 'Edit'], cost: arm === 'ambient' ? 0.01 : 0.02 }) };
    }
    return { stdout: claudeStream({ answer: arm === 'ambient' ? 'Yes, it is.' : 'No.', ambientContext: arm === 'ambient' ? 'ctx' : undefined }) };
  };
  return { handler, inits };
}

describe('runAll', () => {
  it('runs each task in both arms in fresh workspaces and scores them', async () => {
    const seen: Seen[] = [];
    const { handler, inits } = agentHandler(seen);
    const { run } = fakeProc(handler);
    const logs: string[] = [];
    const { prep, runs } = await runAll(config(), { run, log: (l) => logs.push(l), tmpRoot });

    expect(prep).toEqual([expect.objectContaining({ repo: 'r', arm: 'ambient', ok: true })]);
    // One tagged init for the repo base, then one untagged refresh per ambient run.
    expect(inits.filter((a) => !a.includes('--no-tags'))).toHaveLength(1);
    expect(inits.filter((a) => a.includes('--no-tags'))).toHaveLength(2);
    expect(inits[0]).toEqual(expect.arrayContaining(['init', '--quiet', '--samples', '1']));

    // Arms alternate order across tasks.
    expect(runs.map((r) => `${r.taskId}/${r.arm}`)).toEqual(['q1/baseline', 'q1/ambient', 'e1/ambient', 'e1/baseline']);
    expect(seen.map((s) => s.arm)).toEqual(['baseline', 'ambient', 'ambient', 'baseline']);
    for (const s of seen) {
      expect(s.hadGlassbox).toBe(s.arm === 'ambient');
      expect(s.gitClean).toBe(true);
    }
    // The setup (the bug) is in place when the agent starts.
    expect(seen.filter((s) => s.prompt === 'fix a.txt').map((s) => s.aTxt)).toEqual(['bug\n', 'bug\n']);

    const by = (id: string, arm: string) => runs.find((r) => r.taskId === id && r.arm === arm)!;
    expect(by('q1', 'ambient').success).toBe(true);
    expect(by('q1', 'baseline').success).toBe(false);
    expect(by('q1', 'ambient').metrics.ambientChars).toBe(3);
    // The baseline's edit to the protected test was undone, so its real fix still counts.
    expect(by('e1', 'baseline').success).toBe(true);
    expect(by('e1', 'ambient')).toMatchObject({ success: true, answerWords: 2, answerChars: 12, metrics: { toolCalls: 2, costUsd: 0.01 } });
    expect(by('e1', 'ambient').checks).toEqual([expect.objectContaining({ type: 'command', pass: true })]);
    expect(logs.some((l) => l.includes('e1 ambient') && l.includes('PASS'))).toBe(true);
    // Workspaces are removed afterwards, and nothing touched the source repo.
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('ok\n');
    expect(existsSync(join(repo, '.glassbox'))).toBe(false);
  });

  it('records the ambient runs as failed when glassbox init fails, and still runs the baseline', async () => {
    const seen: Seen[] = [];
    const { handler } = agentHandler(seen, { initFails: true });
    const { run } = fakeProc(handler);
    const { prep, runs } = await runAll(config(), { run, log: () => {}, tmpRoot });
    expect(prep[0]).toMatchObject({ ok: false, detail: 'no backend' });
    for (const r of runs.filter((x) => x.arm === 'ambient')) expect(r).toMatchObject({ success: false, error: 'glassbox init failed for this repo' });
    expect(seen.every((s) => s.arm === 'baseline')).toBe(true);
    expect(runs.filter((x) => x.arm === 'baseline')).toHaveLength(2);
  });

  it('records a timeout or an agent error without stopping the run', async () => {
    const { run } = fakeProc((req) => (req.cmd === 'claude' ? { code: null, timedOut: true, stdout: '' } : undefined));
    const { runs } = await runAll(config({ arms: ['baseline'] }), { run, log: () => {}, tmpRoot });
    expect(runs).toHaveLength(2);
    for (const r of runs) expect(r).toMatchObject({ success: false, timedOut: true, error: 'timed out after 30s' });
  });

  it('keeps workspaces when asked and reports their paths', async () => {
    const seen: Seen[] = [];
    const { handler } = agentHandler(seen);
    const { run } = fakeProc(handler);
    const { runs } = await runAll(config({ arms: ['baseline'], keepWorkspaces: true, tasks: taskSet().tasks.slice(0, 1) }), { run, log: () => {}, tmpRoot });
    expect(runs[0]?.workspace).toBeDefined();
    expect(existsSync(runs[0]!.workspace!)).toBe(true);
  });
});

describe('armOrder', () => {
  it('alternates which arm goes first', () => {
    expect(armOrder(['baseline', 'ambient'], 0, 0)).toEqual(['baseline', 'ambient']);
    expect(armOrder(['baseline', 'ambient'], 1, 0)).toEqual(['ambient', 'baseline']);
    expect(armOrder(['baseline', 'ambient'], 1, 1)).toEqual(['baseline', 'ambient']);
  });
});

describe('validateTasks', () => {
  it('confirms the made-up task: its check fails with the bug and passes after the reverse fix', async () => {
    const res = await validateTasks({ ...config(), tasks: taskSet().tasks }, { run: runProc, log: () => {}, tmpRoot });
    expect(res.find((r) => r.taskId === 'e1')).toMatchObject({ failsBefore: true, passesAfter: true });
    // q1 has no reference answer, so the empty answer fails both times.
    expect(res.find((r) => r.taskId === 'q1')).toMatchObject({ failsBefore: true, passesAfter: false });
  });

  it('validates every fixture task in bench/ab/tasks.json (no network, no agent)', async () => {
    const set = loadTaskSet(join(AB, 'tasks.json'));
    const tasks = selectTasks(set, { repo: 'fixture' });
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    const res = await validateTasks({ set, tasks, checksDir: join(AB, 'checks'), cacheDir: join(dir, 'cache') }, { run: runProc, log: () => {}, tmpRoot });
    for (const r of res) expect(r, r.taskId).toMatchObject({ failsBefore: true, passesAfter: true });
  }, 120_000);
});

describe('workspace copies', () => {
  it("leave out the repo's own agent settings, at any depth", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-ab-copy-'));
    try {
      const src = join(dir, 'src');
      for (const d of ['.claude', '.codex', 'pkg/.claude', 'lib']) mkdirSync(join(src, d), { recursive: true });
      writeFileSync(join(src, '.claude', 'settings.json'), '{"hooks":{}}');
      writeFileSync(join(src, 'pkg', '.claude', 'settings.local.json'), '{}');
      writeFileSync(join(src, '.codex', 'config.toml'), '');
      writeFileSync(join(src, '.mcp.json'), '{}');
      writeFileSync(join(src, 'CLAUDE.local.md'), 'run this');
      writeFileSync(join(src, 'CLAUDE.md'), 'kept');
      writeFileSync(join(src, 'lib', 'a.py'), 'x = 1');
      copyTree(src, join(dir, 'dst'));
      expect(readdirSync(join(dir, 'dst')).sort()).toEqual(['CLAUDE.md', 'lib', 'pkg']);
      expect(readdirSync(join(dir, 'dst', 'pkg'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runProc', () => {
  it.skipIf(process.platform === 'win32')('kills the whole process group on a timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-ab-proc-'));
    try {
      const pidFile = join(dir, 'pid');
      const script =
        `const {spawn}=require('child_process');const fs=require('fs');` +
        `const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});` +
        `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},30000);`;
      const r = await runProc({ cmd: process.execPath, args: ['-e', script], cwd: dir, timeoutMs: 1500 });
      expect(r.timedOut).toBe(true);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      const alive = () => {
        try {
          process.kill(grandchild, 0);
          return true;
        } catch {
          return false;
        }
      };
      const end = Date.now() + 4000;
      while (alive() && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
      expect(alive()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
