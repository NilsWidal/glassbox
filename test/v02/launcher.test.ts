import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphOutOfDate, launch, launchPlan, type ForegroundSpawner } from '../../src/launcher.js';
import { cli, indexedFixture } from './helpers.js';

let root: string;
let bin: string;

beforeAll(async () => {
  root = await indexedFixture();
  bin = await mkdtemp(join(tmpdir(), 'glassbox-bin-'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

function recorder(exit: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null }) {
  const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const spawner: ForegroundSpawner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], ...opts });
    return exit;
  };
  return { calls, spawner };
}

describe('launchPlan', () => {
  it('finds the agent on PATH, passes args untouched and sets the host and mode', () => {
    const env = { PATH: bin, GLASSBOX_NESTED: '1' };
    const args = ['-p', 'fix it; rm -rf /', '--model', 'x', '$(whoami)'];
    const plan = launchPlan({ agent: 'claude', args, env, mode: 'auto', root });
    expect(plan.bin).toBe(join(bin, 'claude'));
    expect(plan.args).toEqual(args);
    expect(plan.env).toMatchObject({ GLASSBOX_HOST: 'claude-code', GLASSBOX_MODE: 'auto' });
    expect(plan.env.GLASSBOX_NESTED).toBeUndefined();
    expect(launchPlan({ agent: 'codex', args: [], env: { PATH: bin }, root }).env).toMatchObject({ GLASSBOX_HOST: 'codex' });
    // No mode set anywhere: GLASSBOX_MODE stays unset.
    expect(launchPlan({ agent: 'codex', args: [], env: { PATH: bin }, root }).env.GLASSBOX_MODE).toBeUndefined();
  });

  it('honours GLASSBOX_CLAUDE_BIN and fails clearly when the agent is missing', () => {
    expect(launchPlan({ agent: 'claude', args: [], env: { PATH: '', GLASSBOX_CLAUDE_BIN: join(bin, 'claude') }, root }).bin).toBe(
      join(bin, 'claude'),
    );
    expect(() => launchPlan({ agent: 'codex', args: [], env: { PATH: '/nonexistent' }, root })).toThrow(/"codex" was not found on PATH/);
  });
});

describe('launch', () => {
  it('runs the agent in the caller cwd and returns its exit code', async () => {
    const { calls, spawner } = recorder({ code: 3, signal: null });
    const logs: string[] = [];
    const code = await launch({ agent: 'codex', args: ['exec', 'hi'], root, cwd: join(root, 'src'), env: { PATH: bin }, spawner, log: (l) => logs.push(l) });
    expect(code).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: join(bin, 'codex'), args: ['exec', 'hi'], cwd: join(root, 'src') });
  });

  it('maps a signal exit to 128 + signal number, and a missing agent to 127', async () => {
    const { spawner } = recorder({ code: null, signal: 'SIGINT' });
    expect(await launch({ agent: 'claude', args: [], root, env: { PATH: bin }, spawner, log: () => {} })).toBe(130);
    const logs: string[] = [];
    expect(await launch({ agent: 'claude', args: [], root, env: { PATH: '/nonexistent' }, spawner, log: (l) => logs.push(l) })).toBe(127);
    expect(logs[0]).toMatch(/not found/);
  });

  it('refreshes the graph and AGENTS.md first when a file changed, and starts the worker', async () => {
    const copy = await indexedFixture();
    try {
      expect(await graphOutOfDate(copy)).toBe(false);
      const file = join(copy, 'src/billing/retry.ts');
      writeFileSync(file, `${await readFile(file, 'utf8')}\nexport function newHelper() { return 1; }\n`);
      expect(await graphOutOfDate(copy)).toBe(true);
      const { spawner } = recorder();
      const workers: string[][] = [];
      const logs: string[] = [];
      await launch({
        agent: 'claude',
        args: [],
        root: copy,
        env: { PATH: bin },
        entry: '/bundle.mjs',
        spawner,
        workerSpawner: (_c, args, opts) => void workers.push([...args, String(opts.env.GLASSBOX_HOST)]),
        log: (l) => logs.push(l),
      });
      expect(logs.join('\n')).toMatch(/glassbox: graph refreshed \(\+1 ~\d+ -0\)/);
      expect(await graphOutOfDate(copy)).toBe(false);
      expect(workers).toEqual([['/bundle.mjs', 'worker', 'run', '--root', copy, '--quiet', 'claude-code']]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('a repo without a graph just runs the agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-nograph-'));
    try {
      const { calls, spawner } = recorder();
      expect(await launch({ agent: 'claude', args: ['--version'], root: dir, env: { PATH: bin }, spawner, entry: '/x', log: () => {} })).toBe(0);
      expect(calls[0]!.args).toEqual(['--version']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('glassbox run (CLI)', () => {
  it('passes everything after the agent name through, including options glassbox also has', async () => {
    const { calls, spawner } = recorder();
    const r = await cli(root, ['run', '--mode', 'fast', 'claude', '-p', 'hello', '--mode', 'x', '--json', '--help'], {
      env: { PATH: bin, GLASSBOX_WORKER: '0' },
      spawnForeground: spawner,
    });
    expect(r.code).toBe(0);
    expect(calls[0]!.args).toEqual(['-p', 'hello', '--mode', 'x', '--json', '--help']);
    expect(calls[0]!.env).toMatchObject({ GLASSBOX_MODE: 'fast', GLASSBOX_HOST: 'claude-code' });
  });

  it('returns the agent exit code and rejects an unknown agent', async () => {
    const { spawner } = recorder({ code: 7, signal: null });
    expect((await cli(root, ['run', 'codex'], { env: { PATH: bin }, spawnForeground: spawner })).code).toBe(7);
    expect((await cli(root, ['run', 'gemini'], { env: { PATH: bin }, spawnForeground: spawner })).code).toBe(2);
  });

  it('refuses a bad GLASSBOX_MODE before starting the agent', async () => {
    const { calls, spawner } = recorder();
    const r = await cli(root, ['run', 'claude'], { env: { PATH: bin, GLASSBOX_MODE: 'warp' }, spawnForeground: spawner });
    expect(r.code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
