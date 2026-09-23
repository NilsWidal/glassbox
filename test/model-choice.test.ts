import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCliBackend } from '../src/backends/claude-cli.js';
import { CodexCliBackend } from '../src/backends/codex-cli.js';
import { AnthropicBackend } from '../src/backends/anthropic.js';
import {
  apiModelId,
  claudeSettingsModel,
  describeChoice,
  recordSessionModel,
  resolveAnthropicModel,
  resolveClaudeModel,
  resolveCodexModel,
} from '../src/model-choice.js';
import { modelSwitchHook, parseHookInput, sessionStartHook } from '../src/hooks/index.js';
import { renderStatus, status } from '../src/status.js';
import { answer, batch, fakeRunner } from './backends/helpers.js';

/** A temp HOME and project with nothing in them, and a managed settings path that does not exist. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'glassbox-model-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  const managed = join(base, 'managed-settings.json');
  const env: NodeJS.ProcessEnv = { HOME: home, CLAUDE_PROJECT_DIR: project };
  const opts = (extra: NodeJS.ProcessEnv = {}) => ({ env: { ...env, ...extra }, managedSettings: managed });
  const write = (file: string, json: unknown) => writeFileSync(file, JSON.stringify(json));
  return { base, home, project, managed, env, opts, write };
}

const envelope = (structured: unknown) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured });

describe('resolveClaudeModel precedence', () => {
  it('uses Claude Code settings: project local, then project, then user', () => {
    const s = sandbox();
    expect(resolveClaudeModel(s.opts())).toEqual({ source: 'Claude Code default' });

    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus[1m]' });
    expect(resolveClaudeModel(s.opts())).toEqual({ model: 'opus[1m]', source: '~/.claude/settings.json' });
    expect(describeChoice(resolveClaudeModel(s.opts()))).toBe('opus[1m] from ~/.claude/settings.json');

    s.write(join(s.project, '.claude', 'settings.json'), { model: 'sonnet' });
    expect(resolveClaudeModel(s.opts()).model).toBe('sonnet');
    expect(resolveClaudeModel(s.opts()).source).toBe(join(s.project, '.claude', 'settings.json'));

    s.write(join(s.project, '.claude', 'settings.local.json'), { model: 'claude-opus-4-8' });
    expect(resolveClaudeModel(s.opts()).model).toBe('claude-opus-4-8');

    // Managed settings win over all of them, as in Claude Code.
    s.write(s.managed, { model: 'haiku' });
    expect(resolveClaudeModel(s.opts()).model).toBe('haiku');
  });

  it('respects CLAUDE_CONFIG_DIR instead of ~/.claude', () => {
    const s = sandbox();
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus' });
    const cfg = join(s.base, 'cfg');
    mkdirSync(cfg);
    s.write(join(cfg, 'settings.json'), { model: 'sonnet[1m]' });
    expect(resolveClaudeModel(s.opts({ CLAUDE_CONFIG_DIR: cfg }))).toEqual({ model: 'sonnet[1m]', source: join(cfg, 'settings.json') });
    // A CLAUDE_CONFIG_DIR without settings does not fall back to ~/.claude, as in Claude Code.
    expect(resolveClaudeModel(s.opts({ CLAUDE_CONFIG_DIR: join(s.base, 'empty') })).model).toBeUndefined();
  });

  it('ANTHROPIC_MODEL beats settings; the session model beats both; an explicit override beats everything', () => {
    const s = sandbox();
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus[1m]' });
    expect(resolveClaudeModel(s.opts({ ANTHROPIC_MODEL: 'sonnet' }))).toEqual({ model: 'sonnet', source: 'ANTHROPIC_MODEL' });

    mkdirSync(join(s.project, '.glassbox'));
    expect(recordSessionModel(s.project, 'sess-1', 'claude-opus-5')).toBe(true);
    const sess = s.opts({ ANTHROPIC_MODEL: 'sonnet', CLAUDE_CODE_SESSION_ID: 'sess-1' });
    expect(resolveClaudeModel(sess)).toEqual({ model: 'claude-opus-5', source: 'this Claude Code session' });
    // Another session's file is not used.
    expect(resolveClaudeModel(s.opts({ CLAUDE_CODE_SESSION_ID: 'sess-2' })).model).toBe('opus[1m]');

    expect(resolveClaudeModel({ ...sess, env: { ...sess.env, CLAUDE_PLUGIN_OPTION_MODEL: 'haiku' } })).toEqual({
      model: 'haiku',
      source: 'the plugin model option',
    });
    expect(resolveClaudeModel({ ...sess, env: { ...sess.env, GLASSBOX_MODEL: 'sonnet[1m]', CLAUDE_PLUGIN_OPTION_MODEL: 'haiku' } })).toEqual({
      model: 'sonnet[1m]',
      source: 'GLASSBOX_MODEL',
    });
  });

  it('skips invalid values and unreadable files', () => {
    const s = sandbox();
    writeFileSync(join(s.project, '.claude', 'settings.local.json'), '{ not json');
    s.write(join(s.project, '.claude', 'settings.json'), { model: '--dangerously-skip-permissions' });
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus' });
    expect(resolveClaudeModel(s.opts({ ANTHROPIC_MODEL: '-x' })).model).toBe('opus');
  });

  it('an ANTHROPIC_MODEL in a settings env block counts as the env var', () => {
    const s = sandbox();
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus', env: { ANTHROPIC_MODEL: 'sonnet' } });
    expect(claudeSettingsModel(s.opts())).toEqual({ model: 'sonnet', source: 'ANTHROPIC_MODEL in ~/.claude/settings.json' });
  });

  it('session files are sanitized and only written where .glassbox exists', () => {
    const s = sandbox();
    expect(recordSessionModel(s.project, 'sess', 'opus')).toBe(false);
    mkdirSync(join(s.project, '.glassbox'));
    expect(recordSessionModel(s.project, '../escape', 'opus')).toBe(false);
    expect(recordSessionModel(s.project, 'sess', '--evil')).toBe(false);
    expect(recordSessionModel(s.project, 'sess', 'opus[1m]')).toBe(true);
    const f = JSON.parse(readFileSync(join(s.project, '.glassbox', 'sessions', 'sess.json'), 'utf8')) as { model: string; sessionId: string };
    expect(f).toMatchObject({ sessionId: 'sess', model: 'opus[1m]' });
  });
});

describe('ClaudeCliBackend model', () => {
  it('passes no --model when nothing resolves, and the settings model when one does, re-read on every call', async () => {
    const s = sandbox();
    const { run, calls } = fakeRunner(() => ({ stdout: envelope(answer(0.5, [1, 0, 0])) }));
    const b = new ClaudeCliBackend({ run, samples: 1, ...s.opts() });
    expect(b.args()).not.toContain('--model');
    expect(b.model).toBeUndefined();
    expect(b.modelSource).toBe('Claude Code default');
    await b.answerBatch('s', batch);
    expect(calls[0]!.args).not.toContain('--model');

    // /model saves the choice to settings; the next call follows without a restart.
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus[1m]' });
    await b.answerBatch('s', batch);
    const args = calls[1]!.args;
    expect(args[args.indexOf('--model') + 1]).toBe('opus[1m]');
    expect(b.model).toBe('opus[1m]');
    expect(b.modelSource).toBe('opus[1m] from ~/.claude/settings.json');
    // The nested call still loads no settings itself.
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('GLASSBOX_MODEL is an override', async () => {
    const s = sandbox();
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus[1m]' });
    const b = new ClaudeCliBackend({ samples: 1, ...s.opts({ GLASSBOX_MODEL: 'sonnet' }) });
    expect(b.args().slice(0, 3)).toEqual(['-p', '--model', 'sonnet']);
    expect(b.modelSource).toBe('sonnet from GLASSBOX_MODEL');
  });
});

describe('CodexCliBackend model and effort', () => {
  it('passes no -m and no reasoning effort unless the user set them', () => {
    const s = sandbox();
    const b = new CodexCliBackend({ env: s.env });
    const args = b.args('/tmp/x', undefined, '/tmp/x/out');
    expect(args).not.toContain('-m');
    expect(args.some((a) => a.includes('model_reasoning_effort'))).toBe(false);
    expect(b.modelSource).toBe('Codex default');

    const e = new CodexCliBackend({ env: { ...s.env, GLASSBOX_CODEX_EFFORT: 'high', GLASSBOX_MODEL: 'gpt-5.5' }, model: 'gpt-5.5' });
    const eargs = e.args('/tmp/x', undefined, '/tmp/x/out');
    expect(eargs).toContain('model_reasoning_effort="high"');
    expect(eargs[eargs.indexOf('-m') + 1]).toBe('gpt-5.5');
  });

  it('shows the model from Codex config.toml', () => {
    const s = sandbox();
    mkdirSync(join(s.home, '.codex'));
    writeFileSync(join(s.home, '.codex', 'config.toml'), 'model = "gpt-5.5"\n\n[profiles.fast]\nmodel = "other"\n');
    expect(resolveCodexModel(s.env)).toEqual({ model: 'gpt-5.5', source: '~/.codex/config.toml' });
  });
});

describe('anthropic API backend model', () => {
  it('uses ANTHROPIC_MODEL or the settings model when it is an API id, else the documented fallback', () => {
    const s = sandbox();
    expect(apiModelId('opus')).toBeUndefined();
    expect(apiModelId('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModel(s.opts()).model).toBe('claude-haiku-4-5-20251001');
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'opus[1m]' });
    expect(resolveAnthropicModel(s.opts()).model).toBe('claude-haiku-4-5-20251001');
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'claude-sonnet-4-6' });
    expect(resolveAnthropicModel(s.opts())).toEqual({ model: 'claude-sonnet-4-6', source: '~/.claude/settings.json' });
    expect(new AnthropicBackend({ env: { ...s.env, ANTHROPIC_MODEL: 'claude-opus-4-8' } }).model).toBe('claude-opus-4-8');
  });
});

describe('hooks record the session model', () => {
  it('SessionStart model and PostModelSwitch to_model land in .glassbox/sessions', async () => {
    const s = sandbox();
    mkdirSync(join(s.project, '.glassbox'));
    const ctx = { env: { ...s.env, GLASSBOX_AUTO_INIT: '0' }, cwd: s.project, host: 'claude-code' };
    await sessionStartHook(parseHookInput(JSON.stringify({ session_id: 'abc', hook_event_name: 'SessionStart', model: 'claude-opus-5' })), ctx);
    const read = () => resolveClaudeModel(s.opts({ CLAUDE_CODE_SESSION_ID: 'abc' }));
    expect(read()).toEqual({ model: 'claude-opus-5', source: 'this Claude Code session' });
    modelSwitchHook(parseHookInput(JSON.stringify({ session_id: 'abc', from_model: 'claude-opus-5', to_model: 'claude-sonnet-5' })), ctx);
    expect(read().model).toBe('claude-sonnet-5');
    // Codex hosts are left alone.
    modelSwitchHook(parseHookInput(JSON.stringify({ session_id: 'abc', to_model: 'gpt-5.5' })), { ...ctx, host: 'codex' });
    expect(read().model).toBe('claude-sonnet-5');
    // No .glassbox, no file.
    const t = sandbox();
    modelSwitchHook(parseHookInput(JSON.stringify({ session_id: 'abc', to_model: 'opus' })), { ...ctx, env: t.env, cwd: t.project });
    expect(existsSync(join(t.project, '.glassbox'))).toBe(false);
  });
});

describe('status shows the model and its source', () => {
  it('names the settings file, or Claude Code default', async () => {
    const s = sandbox();
    const env = { ...s.env, GLASSBOX_BACKEND: 'claude-cli' };
    const r0 = await status(s.project, env);
    expect(r0.model).toMatchObject({ backend: 'claude-cli', source: 'Claude Code default' });
    s.write(join(s.project, '.claude', 'settings.local.json'), { model: 'opus[1m]' });
    const r = await status(s.project, env);
    expect(r.model).toEqual({ backend: 'claude-cli', model: 'opus[1m]', source: `opus[1m] from ${join(s.project, '.claude', 'settings.local.json')}` });
    expect(renderStatus(r)).toContain(`model    opus[1m] from ${join(s.project, '.claude', 'settings.local.json')} (claude-cli)`);
    s.write(join(s.home, '.claude', 'settings.json'), { model: 'sonnet' });
    const r2 = await status(s.project, { ...env, GLASSBOX_MODEL: 'haiku' });
    expect(renderStatus(r2)).toContain('model    haiku from GLASSBOX_MODEL (claude-cli)');
  });
});
