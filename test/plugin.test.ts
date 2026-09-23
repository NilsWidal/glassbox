import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'hooks', 'glassbox-hook.sh');
const PKG_VERSION = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
const BUNDLE_FILES = ['glassbox.mjs', 'tree-sitter.wasm', 'tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm', 'tree-sitter-javascript.wasm', 'tree-sitter-python.wasm'];

async function readJson<T>(rel: string): Promise<T> {
  return JSON.parse(await readFile(join(REPO, rel), 'utf8')) as T;
}

describe('plugin manifests', () => {
  it('plugin.json defaults the backend to auto and marks API keys sensitive', async () => {
    const p = await readJson<{ name: string; version: string; userConfig: Record<string, { default?: unknown; sensitive?: boolean; required?: boolean }> }>(
      '.claude-plugin/plugin.json',
    );
    const pkg = await readJson<{ version: string }>('package.json');
    expect(p.name).toBe('glassbox');
    expect(p.version).toBe(pkg.version);
    expect(p.userConfig.backend!.default).toBe('auto');
    expect(p.userConfig.enable_hooks!.default).toBe(false);
    expect(p.userConfig.mode!.default).toBe('balanced');
    for (const key of ['anthropic_api_key', 'openai_api_key']) {
      expect(p.userConfig[key]!.sensitive).toBe(true);
      expect(p.userConfig[key]!.required).toBe(false);
    }
  });

  it('marketplace.json lists the repo itself as the plugin', async () => {
    const m = await readJson<{ name: string; owner: { name: string }; plugins: { name: string; source: string }[] }>('.claude-plugin/marketplace.json');
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'glassbox', source: './' })]);
  });

  it('.mcp.json runs the committed bundle with node, never npx', async () => {
    const m = await readJson<{ mcpServers: Record<string, { command: string; args: string[] }> }>('.mcp.json');
    expect(m.mcpServers.glassbox!.command).toBe('node');
    expect(m.mcpServers.glassbox!.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs', 'mcp']);
    for (const f of ['.mcp.json', 'hooks/hooks.json', 'hooks/glassbox-hook.sh']) {
      expect(await readFile(join(REPO, f), 'utf8'), f).not.toMatch(/npx|@nilswidal\/glassbox@/);
    }
  });

  it('hooks.json wires all four hooks in exec form (no shell string) with bounded timeouts', async () => {
    type Handler = { type: string; command: string; args?: string[]; timeout: number };
    const h = await readJson<{ hooks: Record<string, { matcher?: string; hooks: Handler[] }[]> }>('hooks/hooks.json');
    const want: Record<string, [string, number]> = {
      UserPromptSubmit: ['prompt', 5],
      Stop: ['stop', 60],
      PostToolUse: ['post-edit', 5],
      SessionStart: ['session-start', 30],
    };
    expect(Object.keys(h.hooks).sort()).toEqual(Object.keys(want).sort());
    for (const [event, [arg, maxTimeout]] of Object.entries(want)) {
      const handler = h.hooks[event]![0]!.hooks[0]!;
      expect(handler.type, event).toBe('command');
      expect(handler.command, event).toBe('sh');
      expect(handler.args, event).toEqual(['${CLAUDE_PLUGIN_ROOT}/hooks/glassbox-hook.sh', arg]);
      expect(handler.timeout, event).toBeLessThanOrEqual(maxTimeout);
    }
    expect(h.hooks.PostToolUse![0]!.matcher).toBe('Edit|Write|MultiEdit');
    // The Stop hook must outlive the gate's own default timeout, so the gate (not Claude Code) ends a slow check.
    const { DEFAULT_GATE_TIMEOUT_MS } = await import('../src/hooks/index.js');
    expect(h.hooks.Stop![0]!.hooks[0]!.timeout * 1000).toBeGreaterThan(DEFAULT_GATE_TIMEOUT_MS);
  });

  it('plugin.json offers ambient, gate and concise_rules options, all off by default', async () => {
    const p = await readJson<{ userConfig: Record<string, { type: string; default?: unknown }> }>('.claude-plugin/plugin.json');
    for (const key of ['ambient', 'gate', 'concise_rules', 'enable_hooks']) {
      expect(p.userConfig[key], key).toMatchObject({ type: 'boolean', default: false });
    }
  });

  it('ships the concise output style with the same rules as the AGENTS.md section, not forced on', async () => {
    const { CONCISE_RULES } = await import('../src/style/concise.js');
    const text = await readFile(join(REPO, 'output-styles/concise.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)![1]!;
    expect(fm).toMatch(/^name: concise$/m);
    expect(fm).toMatch(/^keep-coding-instructions: true$/m);
    expect(fm).not.toMatch(/force-for-plugin/);
    for (const rule of CONCISE_RULES) expect(text).toContain(`- ${rule}`);
  });

  it('SKILL.md has spec-only frontmatter and a short description', async () => {
    const text = await readFile(join(REPO, 'skills/glassbox/SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)![1]!;
    const keys = fm.split('\n').map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).toEqual(['name', 'description']);
    const description = /^description: (.*)$/m.exec(fm)![1]!;
    expect(description.length).toBeLessThan(1536);
    for (const tool of ['ask', 'where', 'triage', 'decide']) expect(text).toContain(`\`${tool}\``);
  });

  it('packaging files and docs contain no em dashes', async () => {
    const files = [
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      '.mcp.json',
      'hooks/hooks.json',
      'hooks/glassbox-hook.sh',
      'output-styles/concise.md',
      'skills/glassbox/SKILL.md',
      'docs/codex.md',
      'docs/claude-code.md',
      'README.md',
    ];
    for (const f of files) expect(await readFile(join(REPO, f), 'utf8'), f).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('hook script', () => {
  let tmp: string;
  let project: string;
  let bin: string;
  let log: string;

  let plugin: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'glassbox-hook-'));
    project = join(tmp, 'project');
    bin = join(tmp, 'bin');
    log = join(tmp, 'calls.log');
    await mkdir(join(project, '.glassbox'), { recursive: true });
    await writeFile(join(project, '.glassbox', 'graph.db'), '');
    await mkdir(bin);
    // A stand-in plugin checkout whose bundle records its arguments.
    plugin = join(tmp, 'plugin');
    await mkdir(join(plugin, 'plugin-dist'), { recursive: true });
    await writeFile(
      join(plugin, 'plugin-dist', 'glassbox.mjs'),
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`,
    );
    // A `glassbox` and an `npx` on PATH that must never run.
    for (const name of ['glassbox', 'npx']) {
      await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n`);
      await chmod(join(bin, name), 0o755);
    }
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function runHook(event: string, env: Record<string, string>, input = '', dir = project) {
    await rm(log, { force: true });
    const started = performance.now();
    const r = spawnSync('sh', [HOOK, event], {
      input,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: plugin, ...env },
      encoding: 'utf8',
    });
    const ms = performance.now() - started;
    const calls = await readFile(log, 'utf8').catch(() => '');
    return { code: r.status, stdout: r.stdout, calls: calls.trim(), ms };
  }

  const edit = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b' } });

  it('does nothing unless opted in', async () => {
    const r = await runHook('post-edit', {}, edit);
    expect(r.code).toBe(0);
    expect(r.calls).toBe('');
    expect(r.ms).toBeLessThan(1000);
  });

  it('marks the edited file stale when opted in through the plugin option', async () => {
    const r = await runHook('post-edit', { CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS: 'true' }, edit);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.calls).toBe(`hook post-edit --host claude-code --root ${project}`);
  });

  it('passes the hook JSON through stdin, never as arguments', async () => {
    const odd = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '--sync-md' } });
    const r = await runHook('post-edit', { GLASSBOX_HOOKS: '1' }, odd);
    expect(r.calls).toBe(`hook post-edit --host claude-code --root ${project}`);
  });

  it('runs prompt and stop without the edit-hooks switch (node reads the project config), but not nested or without a graph', async () => {
    for (const event of ['prompt', 'stop']) {
      expect((await runHook(event, {}, '{}')).calls, event).toBe(`hook ${event} --host claude-code --root ${project}`);
      expect((await runHook(event, { GLASSBOX_NESTED: '1' }, '{}')).calls, event).toBe('');
      const none = await runHook(event, {}, '{}', tmp);
      expect(none.calls, event).toBe('');
      expect(none.ms, event).toBeLessThan(1000);
    }
    expect((await runHook('unknown', {}, '{}')).calls).toBe('');
  });

  it('forwards the hook output and always exits 0', async () => {
    const failing = join(tmp, 'failing');
    await mkdir(join(failing, 'plugin-dist'), { recursive: true });
    await writeFile(join(failing, 'plugin-dist', 'glassbox.mjs'), `process.stdout.write('{"decision":"block","reason":"x"}');\nprocess.stderr.write('noise');\nprocess.exit(3);\n`);
    const r = await runHook('stop', { CLAUDE_PLUGIN_ROOT: failing }, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"decision":"block","reason":"x"}');
  });

  it('runs only the plugin bundle: never npx or a `glassbox` from PATH, and nothing without the bundle', async () => {
    const r = await runHook('session-start', { GLASSBOX_HOOKS: '1' });
    expect(r.calls).toBe(`hook session-start --host claude-code --root ${project}`);
    const missing = await runHook('session-start', { GLASSBOX_HOOKS: '1', CLAUDE_PLUGIN_ROOT: join(tmp, 'no-plugin') });
    expect(missing.code).toBe(0);
    expect(missing.calls).toBe('');
    const unset = await runHook('session-start', { GLASSBOX_HOOKS: '1', CLAUDE_PLUGIN_ROOT: '' });
    expect(unset.calls).toBe('');
  });

  it('GLASSBOX_HOOKS=0 overrides the plugin option', async () => {
    const r = await runHook('post-edit', { GLASSBOX_HOOKS: '0', CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS: 'true' }, edit);
    expect(r.calls).toBe('');
  });

  it('never runs inside a nested glassbox call', async () => {
    const r = await runHook('post-edit', { GLASSBOX_HOOKS: '1', GLASSBOX_NESTED: '1' }, edit);
    expect(r.calls).toBe('');
  });

  it('does nothing in a repo without a glassbox graph', async () => {
    const r = await runHook('post-edit', { GLASSBOX_HOOKS: '1' }, edit, tmp);
    expect(r.calls).toBe('');
  });

  it('exits 0 on unreadable input (node, not the script, parses it)', async () => {
    const r = await runHook('post-edit', { GLASSBOX_HOOKS: '1' }, 'not json');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('refreshes the AGENTS.md block at session start without creating CLAUDE.md', async () => {
    const r = await runHook('session-start', { GLASSBOX_HOOKS: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.calls).toBe(`hook session-start --host claude-code --root ${project}`);
  });
});

describe('committed plugin bundle', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'glassbox-bundle-'));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('holds the script and the tree-sitter wasm files', async () => {
    for (const f of BUNDLE_FILES) expect((await stat(join(REPO, 'plugin-dist', f))).size, f).toBeGreaterThan(1000);
  });

  it('runs outside the repo (no node_modules) and indexes the sample repo with the fake backend', async () => {
    // Copy the bundle away from this repo, so nothing can resolve from node_modules.
    const dist = join(tmp, 'plugin', 'plugin-dist');
    await mkdir(dist, { recursive: true });
    for (const f of BUNDLE_FILES) await copyFile(join(REPO, 'plugin-dist', f), join(dist, f));
    const repo = join(tmp, 'repo');
    await cp(join(REPO, 'test', 'fixtures', 'sample-repo'), repo, { recursive: true });
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(dist, 'glassbox.mjs'), ...args], {
        cwd: repo,
        env: { PATH: process.env.PATH ?? '', GLASSBOX_BACKEND: 'fake', NODE_NO_WARNINGS: '1' },
        encoding: 'utf8',
      });
    const version = run('--version');
    expect(version.stdout.trim()).toBe(PKG_VERSION);
    const init = run('init', '--quiet', '--json');
    expect(init.status, init.stderr).toBe(0);
    const out = JSON.parse(init.stdout) as { graph: { files: number; nodes: number } };
    // TypeScript, TSX and Python files all parsed, so every grammar loaded.
    expect(out.graph.files).toBeGreaterThanOrEqual(15);
    expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toContain('<!-- glassbox:start -->');
  }, 30_000);
});
