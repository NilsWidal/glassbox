import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphStore, META_FILE, loadSqlite } from '../../src/memory/store.js';
import { envFlag, featureEnabled, loadProjectConfig, loadProjectConfigSafe, onlyDisables, parseProjectConfig } from '../../src/project-config.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-cfg-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('project config', () => {
  it('keeps known fields of the right type only', () => {
    expect(
      parseProjectConfig({
        mode: 'fast',
        ambient: { enabled: true, maxChars: 900, minScore: 'high' },
        gate: { enabled: 'yes', timeoutMs: 5000 },
        worker: { dailyCalls: -1, maxNodesPerRun: 3 },
        other: 1,
      }),
    ).toEqual({ mode: 'fast', ambient: { enabled: true, maxChars: 900 }, gate: { timeoutMs: 5000 }, worker: { maxNodesPerRun: 3 } });
    expect(parseProjectConfig([1])).toEqual({});
  });

  it('is empty when missing, throws on bad JSON or a symlink, and the safe variant never throws', () => {
    expect(loadProjectConfig(dir)).toEqual({});
    mkdirSync(join(dir, '.glassbox'));
    writeFileSync(join(dir, '.glassbox', 'config.json'), '{');
    expect(() => loadProjectConfig(dir)).toThrow(/not valid JSON/);
    expect(loadProjectConfigSafe(dir)).toEqual({});
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, '{"mode":"fast"}');
    const link = join(dir, '.glassbox', 'config.json');
    rmSync(link);
    symlinkSync(outside, link);
    expect(() => loadProjectConfig(dir)).toThrow(/symlink/);
  });

  it('switches: env, then project, then plugin option, then default', () => {
    const names = { env: 'GLASSBOX_X', plugin: 'CLAUDE_PLUGIN_OPTION_X' };
    expect(featureEnabled({}, names, undefined, false)).toBe(false);
    expect(featureEnabled({ CLAUDE_PLUGIN_OPTION_X: 'true' }, names, undefined, false)).toBe(true);
    expect(featureEnabled({ CLAUDE_PLUGIN_OPTION_X: 'true' }, names, false, false)).toBe(false);
    expect(featureEnabled({ GLASSBOX_X: '1' }, names, false, false)).toBe(true);
    expect([envFlag('on'), envFlag('OFF'), envFlag('maybe'), envFlag(undefined)]).toEqual([true, false, undefined, undefined]);
  });
});

describe('graph store additions', () => {
  it('openForRead returns undefined without a store and never creates one', () => {
    expect(GraphStore.openForRead(dir)).toBeUndefined();
    expect(existsSync(join(dir, '.glassbox'))).toBe(false);
  });

  it('records the last full parse next to graph.db and opens read-only', () => {
    const store = GraphStore.open(dir);
    expect(store.indexedAt()).toBeUndefined();
    store.markIndexed(1234);
    store.upsertNodes([{ id: 'a.ts', kind: 'file', file: 'a.ts', name: 'a.ts', startLine: 1, endLine: 2, hash: 'h', lang: 'ts' }]);
    store.close();
    expect(existsSync(join(dir, '.glassbox', META_FILE))).toBe(true);
    const ro = GraphStore.openForRead(dir)!;
    try {
      expect(ro.indexedAt()).toBe(1234);
      expect(ro.getNodes()).toHaveLength(1);
      expect(() => ro.markStale(['a.ts'])).toThrow();
    } finally {
      ro.close();
    }
  });

  it('refuses a symlinked store directory for reading', () => {
    const real = join(dir, 'elsewhere');
    mkdirSync(real);
    writeFileSync(join(real, 'graph.db'), '');
    symlinkSync(real, join(dir, '.glassbox'));
    expect(() => GraphStore.openForRead(dir)).toThrow(/symlink/);
  });

  it('loads node:sqlite without printing the experimental warning, and restores emitWarning', () => {
    const seen: string[] = [];
    const original = process.emitWarning;
    const recorder = ((w: string | Error) => void seen.push(typeof w === 'string' ? w : w.message)) as typeof process.emitWarning;
    process.emitWarning = recorder;
    try {
      loadSqlite((id) => {
        process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
        process.emitWarning('other warning');
        return process.getBuiltinModule(id);
      });
      expect(process.emitWarning).toBe(recorder);
    } finally {
      process.emitWarning = original;
    }
    expect(seen).toEqual(['other warning']);
  });
});

describe('a project config that git tracks', () => {
  it('keeps only the switches that turn features off', async () => {
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, '.glassbox'));
    const hostile = {
      mode: 'strict',
      ambient: { enabled: true, maxChars: 4000 },
      gate: { enabled: true, timeoutMs: 600_000 },
      conciseRules: true,
      worker: { enabled: true, dailyCalls: 1e9, minIntervalSec: 0, maxNodesPerRun: 1e9 },
    };
    writeFileSync(join(dir, '.glassbox', 'config.json'), JSON.stringify(hostile));
    // Untracked (the normal case): trusted as written.
    expect(loadProjectConfig(dir)).toMatchObject({ mode: 'strict', gate: { enabled: true } });
    git('init', '-q');
    git('add', '-f', '.glassbox/config.json');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'config');
    expect(loadProjectConfig(dir)).toEqual({});
    writeFileSync(
      join(dir, '.glassbox', 'config.json'),
      JSON.stringify({ ambient: { enabled: false, maxHits: 50 }, gate: { enabled: false }, worker: { enabled: false, dailyCalls: 5 }, conciseRules: false }),
    );
    expect(loadProjectConfig(dir)).toEqual({ ambient: { enabled: false }, gate: { enabled: false }, worker: { enabled: false }, conciseRules: false });
    expect(onlyDisables({ gate: { enabled: true }, ambient: { enabled: false } })).toEqual({ ambient: { enabled: false } });
  });

  it('also applies to the graph: openForRead skips a store that git tracks', async () => {
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    GraphStore.open(dir).close();
    expect(GraphStore.openForRead(dir)).toBeDefined();
    GraphStore.openForRead(dir)?.close();
    git('init', '-q');
    git('add', '-f', '.glassbox/graph.db');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'store');
    expect(GraphStore.openForRead(dir)).toBeUndefined();
  });
});
