import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectHost, pickAutoBackend } from '../../src/backends/auto.js';
import { createBackend, resolveBackend } from '../../src/backends/index.js';
import { findOnPath } from '../../src/backends/process.js';

const none = () => false;

describe('auto backend selection', () => {
  it('picks claude-cli inside Claude Code', () => {
    expect(detectHost({ CLAUDECODE: '1' })).toBe('claude-cli');
    expect(pickAutoBackend({ CLAUDECODE: '1', CODEX_THREAD_ID: 'x' }, none)).toBe('claude-cli');
  });

  it('picks codex-cli from a Codex env marker', () => {
    for (const k of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_SANDBOX', 'CODEX_CI']) {
      expect(pickAutoBackend({ [k]: '1' }, none)).toBe('codex-cli');
    }
  });

  it('falls back to the first CLI on PATH', () => {
    expect(pickAutoBackend({}, (c) => c === 'codex')).toBe('codex-cli');
    expect(pickAutoBackend({}, () => true)).toBe('claude-cli');
  });

  it('explains the options when nothing is found, without mentioning local models', () => {
    let msg = '';
    try {
      pickAutoBackend({}, none);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/claude/);
    expect(msg).toMatch(/codex login/);
    expect(msg).toMatch(/ANTHROPIC_API_KEY/);
    expect(msg).not.toMatch(/ollama/i);
  });

  it('finds executables on a PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glassbox-path-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    expect(findOnPath('claude', { PATH: dir })).toBe(bin);
    expect(findOnPath('codex', { PATH: dir })).toBeUndefined();
    expect(findOnPath(bin, { PATH: '' })).toBe(bin);
    expect(pickAutoBackend({ PATH: dir })).toBe('claude-cli');
  });
});

describe('createBackend', () => {
  it('defaults to auto', () => {
    expect(resolveBackend({ env: { CLAUDECODE: '1' } })).toBe('claude-cli');
    expect(createBackend({ env: { CODEX_THREAD_ID: 't' } }).name).toBe('codex-cli');
  });

  it('honors GLASSBOX_BACKEND and GLASSBOX_MODEL', () => {
    const b = createBackend({ env: { GLASSBOX_BACKEND: 'claude-cli', GLASSBOX_MODEL: 'sonnet' } });
    expect(b.name).toBe('claude-cli');
    expect(b.model).toBe('sonnet');
    expect(createBackend({ env: { GLASSBOX_BACKEND: 'claude-cli' } }).model).toBe('haiku');
    expect(createBackend({ env: { GLASSBOX_BACKEND: 'codex-cli' } }).model).toBeUndefined();
    expect(createBackend({ env: { GLASSBOX_BACKEND: 'anthropic' } }).model).toBe('claude-haiku-4-5-20251001');
    expect(createBackend({ env: { GLASSBOX_BACKEND: 'fake' } }).name).toBe('fake');
  });

  it('config overrides env', () => {
    const b = createBackend({ backend: 'codex-cli', model: 'm1', samples: 5, env: { GLASSBOX_BACKEND: 'claude-cli' } });
    expect(b.name).toBe('codex-cli');
    expect(b.model).toBe('m1');
    expect((b as unknown as { samples: number }).samples).toBe(5);
  });

  it('openai-compat needs a model', () => {
    expect(() => createBackend({ env: { GLASSBOX_BACKEND: 'openai-compat' } })).toThrow(/GLASSBOX_MODEL/);
    expect(createBackend({ env: { GLASSBOX_BACKEND: 'openai-compat', GLASSBOX_MODEL: 'gpt-x' } }).capabilities.hasLogprobs).toBe(true);
  });

  it('rejects an unknown backend name', () => {
    expect(() => createBackend({ env: { GLASSBOX_BACKEND: 'nope' } })).toThrow(/unknown GLASSBOX_BACKEND/);
  });
});
