import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { storeTrackedByGit } from '../../src/util/tracked.js';
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

describe('storeTrackedByGit', () => {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], {
      cwd,
      stdio: 'ignore',
    });

  it('is false outside git and for an untracked store', () => {
    mkdirSync(join(dir, '.glassbox'));
    writeFileSync(join(dir, '.glassbox', 'config.json'), '{}');
    expect(storeTrackedByGit(dir)).toBe(false);
    run(dir, 'init', '-q');
    expect(storeTrackedByGit(dir)).toBe(false);
  });

  it('sees a store committed under another letter case', () => {
    run(dir, 'init', '-q');
    run(dir, 'config', 'core.ignorecase', 'false');
    mkdirSync(join(dir, '.GlassBox'));
    writeFileSync(join(dir, '.GlassBox', 'CONFIG.json'), JSON.stringify({ mode: 'strict', gate: { enabled: true } }));
    run(dir, 'add', '-f', '.GlassBox/CONFIG.json');
    run(dir, 'commit', '-qm', 'x');
    expect(storeTrackedByGit(dir)).toBe(true);
  });

  it('reduces a config in a store committed as CONFIG.json (case-insensitive file systems read it as config.json)', () => {
    run(dir, 'init', '-q');
    mkdirSync(join(dir, '.glassbox'));
    writeFileSync(join(dir, '.glassbox', 'CONFIG.json'), '{}');
    run(dir, 'add', '-f', '.glassbox/CONFIG.json');
    run(dir, 'commit', '-qm', 'x');
    writeFileSync(join(dir, '.glassbox', 'config.json'), JSON.stringify({ mode: 'strict', gate: { enabled: true } }));
    expect(loadProjectConfig(dir)).toEqual({});
    // The graph next to it is not read either.
    GraphStore.open(dir).close();
    expect(GraphStore.openForRead(dir)).toBeUndefined();
  });

  it('sees a store shipped as a submodule, a .gitmodules entry or a nested checkout', () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    run(sub, 'init', '-q');
    writeFileSync(join(sub, 'config.json'), JSON.stringify({ mode: 'strict', gate: { enabled: true } }));
    run(sub, 'add', 'config.json');
    run(sub, 'commit', '-qm', 'cfg');
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    run(repo, 'init', '-q');
    run(repo, 'submodule', 'add', '-q', sub, '.glassbox');
    run(repo, 'commit', '-qm', 'sub');
    expect(storeTrackedByGit(repo)).toBe(true);
    expect(loadProjectConfig(repo)).toEqual({});
    // Each signal on its own.
    const only = (setup: (root: string) => void) => {
      const root = mkdtempSync(join(dir, 'only-'));
      run(root, 'init', '-q');
      mkdirSync(join(root, '.glassbox'));
      setup(root);
      return storeTrackedByGit(root);
    };
    expect(only((r) => writeFileSync(join(r, '.gitmodules'), '[submodule "x"]\n\tpath = .glassbox\n\turl = ../x\n'))).toBe(true);
    expect(only((r) => mkdirSync(join(r, '.glassbox', '.git')))).toBe(true);
    expect(only(() => {})).toBe(false);
  });
});
