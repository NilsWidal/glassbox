import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backends/fake.js';
import {
  editHooksEnabled,
  editedFiles,
  findGraphRoot,
  parseHookInput,
  postEditHook,
  promptHook,
  readGateState,
  stopHook,
  type HookContext,
} from '../../src/hooks/index.js';
import { GraphStore } from '../../src/memory/store.js';
import { fixtureCopy } from '../query/helpers.js';
import { cli, indexedFixture, rules } from './helpers.js';

let root: string;

beforeAll(async () => {
  root = await indexedFixture({ git: true });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(extra: Partial<HookContext> = {}): HookContext {
  return { env: {}, cwd: root, ...extra };
}

describe('hook input', () => {
  it('parses the fields glassbox uses and ignores the rest', () => {
    expect(parseHookInput('{"prompt":"hi","cwd":"/x","stop_hook_active":true,"session_id":7,"extra":1}')).toEqual({
      prompt: 'hi',
      cwd: '/x',
      stop_hook_active: true,
    });
    expect(parseHookInput('not json')).toEqual({});
    expect(parseHookInput('[1,2]')).toEqual({});
    expect(parseHookInput('')).toEqual({});
  });

  it('finds the graph root from a subdirectory, but not above a git root', async () => {
    expect(findGraphRoot(join(root, 'src', 'auth'))).toBe(root);
    const bare = await fixtureCopy();
    try {
      mkdirSync(join(bare, '.git'));
      expect(findGraphRoot(join(bare, 'src'))).toBeUndefined();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('reads edited files from Claude Code and Codex tool input', () => {
    expect(editedFiles({ file_path: 'src/a.ts', old_string: 'x' })).toEqual(['src/a.ts']);
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** Move to: src/c.ts\n*** End Patch';
    expect(editedFiles({ command: ['apply_patch', patch] })).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(editedFiles(undefined)).toEqual([]);
  });

  it('keeps the v0.1 switch for edit hooks', () => {
    expect(editHooksEnabled({})).toBe(false);
    expect(editHooksEnabled({ CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS: 'true' })).toBe(true);
    expect(editHooksEnabled({ GLASSBOX_HOOKS: '0', CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS: 'true' })).toBe(false);
  });
});

describe('prompt hook', () => {
  const input = { prompt: 'why does verifySession reject expired sessions?', cwd: root };

  it('is off unless ambient mode is enabled', () => {
    expect(promptHook({ ...input, cwd: root }, ctx())).toBe('');
  });

  it('returns additionalContext JSON when enabled by env, config or plugin option', async () => {
    const out = promptHook({ ...input, cwd: root }, ctx({ env: { GLASSBOX_AMBIENT: '1' } }));
    const json = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(json.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(json.hookSpecificOutput.additionalContext).toContain('verifySession');
    expect(promptHook({ ...input, cwd: root }, ctx({ env: { CLAUDE_PLUGIN_OPTION_AMBIENT: 'true' } }))).not.toBe('');
    await writeFile(join(root, '.glassbox', 'config.json'), JSON.stringify({ ambient: { enabled: true, maxChars: 400 } }));
    try {
      const viaConfig = JSON.parse(promptHook({ ...input, cwd: root }, ctx())) as { hookSpecificOutput: { additionalContext: string } };
      expect(viaConfig.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(400);
      // GLASSBOX_AMBIENT=0 wins over the config.
      expect(promptHook({ ...input, cwd: root }, ctx({ env: { GLASSBOX_AMBIENT: '0' } }))).toBe('');
    } finally {
      await rm(join(root, '.glassbox', 'config.json'));
    }
  });

  it('does nothing nested, without .glassbox, or for chat', async () => {
    const env = { GLASSBOX_AMBIENT: '1' };
    expect(promptHook({ ...input, cwd: root }, ctx({ env: { ...env, GLASSBOX_NESTED: '1' } }))).toBe('');
    expect(promptHook({ prompt: 'thanks', cwd: root }, ctx({ env }))).toBe('');
    const bare = await fixtureCopy();
    try {
      expect(promptHook({ ...input, cwd: bare }, { env, cwd: bare })).toBe('');
      expect(existsSync(join(bare, '.glassbox'))).toBe(false);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('post-edit hook', () => {
  it('marks the edited file stale and starts the worker once', async () => {
    const copy = await indexedFixture();
    try {
      const spawned: string[][] = [];
      const c: HookContext = {
        env: { GLASSBOX_HOOKS: '1' },
        cwd: copy,
        entry: '/bundle.mjs',
        host: 'codex',
        now: () => Date.now(),
        spawner: (_cmd, args, opts) => void spawned.push([...args, `host=${opts.env.GLASSBOX_HOST}`]),
      };
      await postEditHook({ tool_name: 'Edit', tool_input: { file_path: join(copy, 'src/billing/retry.ts') }, cwd: copy }, c);
      await postEditHook({ tool_name: 'Edit', tool_input: { file_path: 'src/billing/retry.ts' }, cwd: copy }, c);
      const store = GraphStore.open(copy);
      expect(store.getNodes({ file: 'src/billing/retry.ts' }).every((n) => n.stale)).toBe(true);
      store.close();
      expect(spawned).toEqual([['/bundle.mjs', 'worker', 'run', '--root', copy, '--quiet', 'host=codex']]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('is off without GLASSBOX_HOOKS or the plugin option', async () => {
    const copy = await indexedFixture();
    try {
      await postEditHook({ tool_input: { file_path: 'src/billing/retry.ts' }, cwd: copy }, { env: {}, cwd: copy });
      const store = GraphStore.open(copy);
      expect(store.getNodes({ file: 'src/billing/retry.ts' }).some((n) => n.stale)).toBe(false);
      store.close();
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe('stop hook (end-of-turn gate)', () => {
  const RISKY = (text: string) => text.replace('session.expiresAt < Date.now()', 'session.expiresAt <= Date.now()');

  function gateCtx(dir: string, backend: FakeBackend, env: NodeJS.ProcessEnv = { GLASSBOX_GATE: '1' }): HookContext {
    return { env, cwd: dir, backend: () => backend };
  }

  it('blocks once when a changed hunk is High risk in the act band, then lets the same diff through', async () => {
    const copy = await indexedFixture({ git: true });
    try {
      const file = join(copy, 'src/auth/session.ts');
      writeFileSync(file, RISKY(readFileSync(file, 'utf8')));
      const backend = new FakeBackend({ rules });
      const out = await stopHook({ cwd: copy }, gateCtx(copy, backend));
      const json = JSON.parse(out) as { decision: string; reason: string };
      expect(json.decision).toBe('block');
      expect(json.reason).toMatch(/^glassbox gate: 1 changed hunk rated High risk/);
      expect(json.reason).toMatch(/- src\/auth\/session\.ts:\d+-\d+ \(verifySession\) High risk, p=0\.9\d/);
      // Fast mode: one option order, one call for the whole diff.
      expect(backend.calls).toHaveLength(1);
      expect(readGateState(copy)?.outcome).toBe('block');
      expect(await stopHook({ cwd: copy }, gateCtx(copy, backend))).toBe('');
      expect(backend.calls).toHaveLength(1);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('passes a low-risk diff and respects stop_hook_active, the switch and nesting', async () => {
    const copy = await indexedFixture({ git: true });
    try {
      await writeFile(join(copy, 'src/ui/format.ts'), `${await readFile(join(copy, 'src/ui/format.ts'), 'utf8')}\n// note\n`);
      const backend = new FakeBackend({ rules });
      expect(await stopHook({ cwd: copy, stop_hook_active: true }, gateCtx(copy, backend))).toBe('');
      expect(await stopHook({ cwd: copy }, gateCtx(copy, backend, {}))).toBe('');
      expect(await stopHook({ cwd: copy }, gateCtx(copy, backend, { GLASSBOX_GATE: '1', GLASSBOX_NESTED: '1' }))).toBe('');
      expect(backend.calls).toHaveLength(0);
      expect(await stopHook({ cwd: copy }, gateCtx(copy, backend))).toBe('');
      expect(backend.calls).toHaveLength(1);
      expect(readGateState(copy)?.outcome).toBe('pass');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('fails open on a timeout and does not retry the same diff', async () => {
    const copy = await indexedFixture({ git: true });
    try {
      const file = join(copy, 'src/auth/session.ts');
      writeFileSync(file, RISKY(readFileSync(file, 'utf8')));
      await writeFile(join(copy, '.glassbox', 'config.json'), JSON.stringify({ gate: { enabled: true, timeoutMs: 1000 } }));
      const slow = new FakeBackend({ rules, delayMs: 3000 });
      const started = Date.now();
      expect(await stopHook({ cwd: copy }, gateCtx(copy, slow, {}))).toBe('');
      expect(Date.now() - started).toBeLessThan(2500);
      expect(readGateState(copy)?.outcome).toBe('timeout');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe('stop hook: more gate cases', () => {
  const RISKY = (text: string) => text.replace('session.expiresAt < Date.now()', 'session.expiresAt <= Date.now()');

  it('fails open when the backend errors, records it, and does not retry that diff', async () => {
    const copy = await indexedFixture({ git: true });
    try {
      const file = join(copy, 'src/auth/session.ts');
      writeFileSync(file, RISKY(readFileSync(file, 'utf8')));
      const broken = new FakeBackend({ rules, failCalls: [0, 1, 2, 3, 4, 5] });
      const c: HookContext = { env: { GLASSBOX_GATE: '1' }, cwd: copy, backend: () => broken };
      expect(await stopHook({ cwd: copy }, c)).toBe('');
      expect(readGateState(copy)?.outcome).toBe('error');
      const calls = broken.calls.length;
      expect(await stopHook({ cwd: copy }, c)).toBe('');
      expect(broken.calls.length).toBe(calls);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('runs again when the diff changes, uses balanced mode from config, and does nothing on a clean tree', async () => {
    const copy = await indexedFixture({ git: true });
    try {
      const backend = new FakeBackend({ rules });
      const seen: (number | undefined)[] = [];
      const c: HookContext = {
        env: {},
        cwd: copy,
        backend: ({ samples }) => ((seen.push(samples), backend)),
      };
      await writeFile(join(copy, '.glassbox', 'config.json'), JSON.stringify({ gate: { enabled: true, mode: 'balanced' } }));
      expect(await stopHook({ cwd: copy }, c)).toBe('');
      expect(backend.calls).toHaveLength(0);
      const file = join(copy, 'src/auth/session.ts');
      writeFileSync(file, RISKY(readFileSync(file, 'utf8')));
      const first = JSON.parse(await stopHook({ cwd: copy }, c)) as { decision: string };
      expect(first.decision).toBe('block');
      // balanced: the backend's own samples (none forced) and 2 option orders.
      expect(seen).toEqual([undefined]);
      expect(backend.calls.length).toBeGreaterThanOrEqual(2);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n// reviewed\n`);
      const again = await stopHook({ cwd: copy }, c);
      expect(again === '' || (JSON.parse(again) as { decision: string }).decision === 'block').toBe(true);
      expect(seen).toHaveLength(2);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('does not block again in a later turn for a hunk it already flagged', async () => {
    const copy = await indexedFixture({ git: true });
    try {
      const file = join(copy, 'src/auth/session.ts');
      writeFileSync(file, RISKY(readFileSync(file, 'utf8')));
      const backend = new FakeBackend({ rules });
      const c: HookContext = { env: { GLASSBOX_GATE: '1' }, cwd: copy, backend: () => backend };
      expect((JSON.parse(await stopHook({ cwd: copy }, c)) as { decision: string }).decision).toBe('block');
      expect(readGateState(copy)?.flagged).toEqual(['src/auth/session.ts#src/auth/session.ts#verifySession']);
      // Next turn: another edit in the same function changes the diff; the flagged change is still in it.
      writeFileSync(file, readFileSync(file, 'utf8').replace('store.revoke(token);', 'store.revoke(token); // expired'));
      expect(await stopHook({ cwd: copy }, c)).toBe('');
      expect(backend.calls.length).toBeGreaterThanOrEqual(2);
      expect(readGateState(copy)).toMatchObject({ outcome: 'pass', flagged: ['src/auth/session.ts#src/auth/session.ts#verifySession'] });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('can be switched on by the plugin option alone', async () => {
    const copy = await indexedFixture({ git: true });
    try {
      const file = join(copy, 'src/auth/session.ts');
      writeFileSync(file, RISKY(readFileSync(file, 'utf8')));
      const backend = new FakeBackend({ rules });
      const out = await stopHook({ cwd: copy }, { env: { CLAUDE_PLUGIN_OPTION_GATE: 'true' }, cwd: copy, backend: () => backend });
      expect((JSON.parse(out) as { decision: string }).decision).toBe('block');
      const off = await indexedFixture({ git: true });
      try {
        writeFileSync(join(off, 'src/auth/session.ts'), RISKY(readFileSync(join(off, 'src/auth/session.ts'), 'utf8')));
        await writeFile(join(off, '.glassbox', 'config.json'), JSON.stringify({ gate: { enabled: false } }));
        expect(await stopHook({ cwd: off }, { env: { CLAUDE_PLUGIN_OPTION_GATE: 'true' }, cwd: off, backend: () => backend })).toBe('');
      } finally {
        await rm(off, { recursive: true, force: true });
      }
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe('glassbox hook (CLI entry)', () => {
  it('prints the prompt hook JSON and exits 0', async () => {
    const r = await cli(root, ['hook', 'prompt'], {
      env: { GLASSBOX_AMBIENT: '1' },
      readStdin: async () => JSON.stringify({ prompt: 'where is issueToken used?', cwd: root }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  });

  it('exits 0 with no output on bad input, a stdin that never closes, or nesting', async () => {
    const env = { GLASSBOX_AMBIENT: '1' };
    expect(await cli(root, ['hook', 'prompt'], { env, readStdin: async () => '{{{' })).toEqual({ code: 0, out: '', err: '' });
    const hang = await cli(root, ['hook', 'stop'], { env, readStdin: () => new Promise<string>(() => {}) });
    expect(hang).toEqual({ code: 0, out: '', err: '' });
    let read = false;
    const nested = await cli(root, ['hook', 'prompt'], {
      env: { ...env, GLASSBOX_NESTED: '1' },
      readStdin: async () => ((read = true), '{}'),
    });
    expect(nested).toEqual({ code: 0, out: '', err: '' });
    expect(read).toBe(false);
  }, 10_000);

  it('does nothing in a directory without .glassbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-nohook-'));
    try {
      for (const event of ['prompt', 'stop', 'post-edit', 'session-start']) {
        const r = await cli(dir, ['hook', event], {
          env: { GLASSBOX_AMBIENT: '1', GLASSBOX_GATE: '1', GLASSBOX_HOOKS: '1' },
          readStdin: async () => JSON.stringify({ prompt: 'fix verifySession', cwd: dir, tool_input: { file_path: 'a.ts' } }),
        });
        expect(r).toEqual({ code: 0, out: '', err: '' });
      }
      expect(existsSync(join(dir, '.glassbox'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
