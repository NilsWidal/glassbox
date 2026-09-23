import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, isBackendName, resolveBackendName, resolveModel, sha256, stableStringify } from '../src/index.js';

describe('config', () => {
  it('has host-CLI defaults', () => {
    // No glassbox default for the host CLIs: they mirror the model selected in Claude Code / Codex.
    expect(DEFAULT_MODELS['claude-cli']).toBeUndefined();
    expect(DEFAULT_MODELS.anthropic).toBe('claude-haiku-4-5-20251001');
    expect(DEFAULT_MODELS['codex-cli']).toBeUndefined();
  });
  it('GLASSBOX_MODEL overrides the default', () => {
    expect(resolveModel('claude-cli', {})).toBeUndefined();
    expect(resolveModel('claude-cli', { GLASSBOX_MODEL: 'sonnet' })).toBe('sonnet');
    expect(resolveModel('codex-cli', { GLASSBOX_MODEL: ' ' })).toBeUndefined();
  });
  it('GLASSBOX_BACKEND defaults to auto and is validated', () => {
    expect(resolveBackendName({})).toBe('auto');
    expect(resolveBackendName({ GLASSBOX_BACKEND: 'codex-cli' })).toBe('codex-cli');
    expect(() => resolveBackendName({ GLASSBOX_BACKEND: 'nope' })).toThrow(/unknown GLASSBOX_BACKEND/);
    expect(isBackendName('claude-cli')).toBe(true);
    expect(isBackendName(3)).toBe(false);
  });
});

describe('util', () => {
  it('stableStringify sorts nested keys', () => {
    expect(stableStringify({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });
  it('sha256 is hex', () => {
    expect(sha256('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
