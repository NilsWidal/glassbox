import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'hooks', 'glassbox-hook.sh');

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

  it('.mcp.json starts the server with `glassbox mcp`', async () => {
    const m = await readJson<{ mcpServers: Record<string, { command: string; args: string[] }> }>('.mcp.json');
    expect(m.mcpServers.glassbox!.args.slice(-2)).toEqual(['@nilswidal/glassbox', 'mcp']);
  });

  it('hooks.json wires opt-in edit and session hooks with short timeouts', async () => {
    const h = await readJson<{ hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]> }>('hooks/hooks.json');
    const post = h.hooks.PostToolUse![0]!;
    expect(post.matcher).toBe('Edit|Write|MultiEdit');
    expect(post.hooks[0]!.command).toContain('glassbox-hook.sh" post-edit');
    expect(post.hooks[0]!.timeout).toBeLessThanOrEqual(5);
    expect(h.hooks.SessionStart![0]!.hooks[0]!.command).toContain('session-start');
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
      'skills/glassbox/SKILL.md',
      'docs/codex.md',
      'docs/claude-code.md',
      'README.md',
    ];
    for (const f of files) expect(await readFile(join(REPO, f), 'utf8'), f).not.toContain('—');
  });
});

describe('hook script', () => {
  let tmp: string;
  let project: string;
  let bin: string;
  let log: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'glassbox-hook-'));
    project = join(tmp, 'project');
    bin = join(tmp, 'bin');
    log = join(tmp, 'calls.log');
    await mkdir(join(project, '.glassbox'), { recursive: true });
    await writeFile(join(project, '.glassbox', 'graph.db'), '');
    await mkdir(bin);
    // A stand-in `glassbox` on PATH that records its arguments.
    await writeFile(join(bin, 'glassbox'), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    await chmod(join(bin, 'glassbox'), 0o755);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function runHook(event: string, env: Record<string, string>, input = '', dir = project) {
    await rm(log, { force: true });
    const started = performance.now();
    const r = spawnSync('sh', [HOOK, event], {
      input,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDE_PROJECT_DIR: dir, ...env },
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
    expect(r.calls).toBe(`refresh --root ${project} --files /p/src/a.ts --quiet`);
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

  it('ignores hook input without a file path', async () => {
    const r = await runHook('post-edit', { GLASSBOX_HOOKS: '1' }, 'not json');
    expect(r.code).toBe(0);
    expect(r.calls).toBe('');
  });

  it('refreshes the AGENTS.md block at session start without creating CLAUDE.md', async () => {
    const r = await runHook('session-start', { GLASSBOX_HOOKS: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.calls).toBe(`refresh --root ${project} --sync-md --no-claude-md --quiet`);
  });
});
