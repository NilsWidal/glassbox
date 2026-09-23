import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRule } from '../src/backends/fake.js';
import { main, type CliIo } from '../src/cli/index.js';
import {
  MODE_SETTINGS,
  modeDecideOptions,
  renderModeLine,
  resolveMode,
  runWithMode,
  whereBand,
  withModeJson,
  withModeText,
} from '../src/modes.js';
import { fixtureCopy } from './query/helpers.js';

let root: string;

beforeAll(async () => {
  root = await fixtureCopy();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(dir: string, value: unknown) {
  await mkdir(join(dir, '.glassbox'), { recursive: true });
  await writeFile(join(dir, '.glassbox', 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('resolveMode', () => {
  it('defaults to balanced with source default', () => {
    expect(resolveMode({ env: {} })).toEqual({ mode: 'balanced', source: 'default' });
  });

  it('takes the call, then GLASSBOX_MODE, then the project config, then the plugin option', async () => {
    const dir = await fixtureCopy();
    try {
      await writeConfig(dir, { mode: 'strict' });
      const env = { GLASSBOX_MODE: 'explained', CLAUDE_PLUGIN_OPTION_MODE: 'auto' };
      expect(resolveMode({ explicit: 'fast', env, root: dir })).toEqual({ mode: 'fast', source: 'call' });
      expect(resolveMode({ env, root: dir })).toEqual({ mode: 'explained', source: 'env' });
      expect(resolveMode({ env: { CLAUDE_PLUGIN_OPTION_MODE: 'auto' }, root: dir })).toEqual({ mode: 'strict', source: 'project' });
      expect(resolveMode({ env: { CLAUDE_PLUGIN_OPTION_MODE: 'auto' }, root })).toEqual({ mode: 'auto', source: 'plugin' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown mode and names where it came from', () => {
    expect(() => resolveMode({ explicit: 'turbo', env: {} })).toThrow(/unknown mode "turbo" in the call/);
    expect(() => resolveMode({ env: { GLASSBOX_MODE: 'slow' } })).toThrow(/GLASSBOX_MODE/);
  });

  it('treats a broken config.json as an error for the CLI', async () => {
    const dir = await fixtureCopy();
    try {
      await writeConfig(dir, '{not json');
      expect(() => resolveMode({ env: {}, root: dir })).toThrow(/not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runWithMode', () => {
  it('runs a concrete mode once with its settings', async () => {
    const seen: string[] = [];
    const r = await runWithMode(
      'strict',
      async (m, s) => {
        seen.push(m);
        return s.samples;
      },
      () => 'confirm',
    );
    expect(seen).toEqual(['strict']);
    expect(r).toEqual({ result: 5, used: 'strict' });
  });

  it('auto stays in fast when the band is act', async () => {
    const seen: string[] = [];
    const r = await runWithMode('auto', async (m) => (seen.push(m), m), () => 'act');
    expect(seen).toEqual(['fast']);
    expect(r.used).toBe('fast');
    expect(r.escalated).toBeUndefined();
  });

  it('auto escalates to explained when the fast band is not act', async () => {
    const seen: string[] = [];
    const r = await runWithMode('auto', async (m) => (seen.push(m), m), (m) => (m === 'fast' ? 'escalate' : 'act'));
    expect(seen).toEqual(['fast', 'explained']);
    expect(r).toEqual({ result: 'explained', used: 'explained', escalated: { from: 'fast', band: 'escalate' } });
  });
});

describe('mode helpers', () => {
  it('builds decide options: an explicit permutation count wins, bands come from the mode', () => {
    expect(modeDecideOptions(MODE_SETTINGS.balanced)).toBeUndefined();
    expect(modeDecideOptions(MODE_SETTINGS.fast)).toEqual({ permutations: 1 });
    expect(modeDecideOptions(MODE_SETTINGS.fast, 4)).toEqual({ permutations: 4 });
    expect(modeDecideOptions(MODE_SETTINGS.strict)).toEqual({ permutations: 3, bands: { act: 0.9, confirm: 0.7 } });
    const cal = { q: { kind: 'temperature' as const, T: 2 } };
    expect(modeDecideOptions(MODE_SETTINGS.balanced, undefined, cal)).toEqual({ calibrators: cal });
  });

  it('prints a mode line only when a mode was set', () => {
    expect(renderModeLine({ requested: 'balanced', source: 'default', used: 'balanced' })).toBe('');
    expect(renderModeLine({ requested: 'fast', source: 'env', used: 'fast' })).toBe('mode   fast');
    expect(renderModeLine({ requested: 'auto', source: 'call', used: 'fast' })).toBe('mode   auto: fast (band act)');
    expect(
      renderModeLine({ requested: 'auto', source: 'call', used: 'explained', escalated: { from: 'fast', band: 'confirm' } }),
    ).toBe('mode   auto: fast gave band confirm, asked again in explained');
    const def = { requested: 'balanced' as const, source: 'default' as const, used: 'balanced' as const };
    expect(withModeText('x', def)).toBe('x');
    expect(withModeJson({ a: 1 }, def)).toEqual({ a: 1 });
    expect(withModeJson({ a: 1 }, { ...def, source: 'plugin' })).toEqual({ a: 1 });
    const fast = { requested: 'fast' as const, source: 'env' as const, used: 'fast' as const };
    expect(withModeJson({ a: 1 }, fast)).toEqual({ a: 1, mode: fast });
  });

  it('bands a where result by its top hit', () => {
    expect(whereBand(undefined)).toBeUndefined();
    expect(whereBand(0.97)).toBe('act');
    expect(whereBand(0.85)).toBe('confirm');
    expect(whereBand(0.5)).toBe('escalate');
    expect(whereBand(0.96, { act: 0.9 })).toBe('act');
    expect(whereBand(0.96, { act: 0.95 })).toBe('confirm');
  });
});

describe('cli --mode', () => {
  // P(yes) 0.7 gives confidence 0.4: band escalate, so auto asks again.
  const unsure: FakeRule = (ctx) => (ctx.questionId === 'q' && ctx.question.instructions.includes('unsure') ? 0.7 : undefined);
  const sure: FakeRule = (ctx) => (ctx.questionId === 'q' ? 0.99 : undefined);

  async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readStdin: async () => '',
      env: { GLASSBOX_BACKEND: 'fake', ...env },
      cwd: root,
      backendConfig: { fake: { rules: [unsure, sure] } },
    };
    const code = await main(args, io);
    return { code, out: out.join(''), err: err.join('') };
  }

  it('fast asks once, in one option order, without evidence', async () => {
    const r = await run(['ask', 'is this code about sessions?', '-p', 'src/auth/session.ts', '--mode', 'fast', '--json', '--no-log']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { calls: { decide: number; explain: number; why: number }; explain?: unknown; mode: unknown };
    expect(j.calls).toEqual({ decide: 1, explain: 0, why: 0 });
    expect(j.explain).toBeUndefined();
    expect(j.mode).toEqual({ requested: 'fast', source: 'call', used: 'fast' });
  });

  it('balanced keeps the v0.1 defaults and prints no mode', async () => {
    const r = await run(['ask', 'is this code about sessions?', '-p', 'src/auth/session.ts', '--json', '--no-log']);
    const j = JSON.parse(r.out) as { calls: { decide: number }; mode?: unknown };
    expect(j.calls.decide).toBe(2);
    expect(j.mode).toBeUndefined();
  });

  it('explained adds evidence; GLASSBOX_MODE sets it without a flag', async () => {
    const r = await run(['ask', 'is this code about sessions?', '-p', 'src/auth/session.ts', '--json', '--no-log'], {
      GLASSBOX_MODE: 'explained',
    });
    const j = JSON.parse(r.out) as { explain?: { highlights: unknown[] }; mode: { source: string } };
    expect(j.explain).toBeDefined();
    expect(j.mode.source).toBe('env');
  });

  it('auto escalates an unsure answer to explained and says so', async () => {
    const r = await run(['ask', 'unsure: is this code about sessions?', '-p', 'src/auth/session.ts', '--mode', 'auto', '--no-log']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('mode   auto: fast gave band escalate, asked again in explained');
  });

  it('auto keeps a sure answer in fast', async () => {
    const r = await run(['ask', 'is this code about sessions?', '-p', 'src/auth/session.ts', '--mode', 'auto', '--no-log']);
    expect(r.out).toContain('mode   auto: fast (band act)');
  });

  it('an explicit --permutations wins over the mode', async () => {
    const r = await run(['ask', 'x?', '-p', 'src/auth/session.ts', '--mode', 'fast', '--permutations', '3', '--json', '--no-log']);
    expect((JSON.parse(r.out) as { calls: { decide: number } }).calls.decide).toBe(3);
  });

  it('rejects an unknown GLASSBOX_MODE as a usage error', async () => {
    const r = await run(['ask', 'x?', '-p', 'src/auth/session.ts', '--no-log'], { GLASSBOX_MODE: 'warp' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown mode "warp"/);
  });

  it('commander refuses an unknown --mode', async () => {
    const r = await run(['ask', 'x?', '--mode', 'warp']);
    expect(r.code).toBe(2);
  });
});
