import type { BackendName } from './types.js';

/**
 * Default model per backend. Model ids are config values: GLASSBOX_MODEL
 * overrides them. codex-cli has no default, so the Codex CLI's own configured
 * model is used (no -m flag).
 */
export const DEFAULT_MODELS: Readonly<Record<Exclude<BackendName, 'auto'>, string | undefined>> = Object.freeze({
  'claude-cli': 'haiku',
  'codex-cli': undefined,
  anthropic: 'claude-haiku-4-5-20251001',
  'openai-compat': undefined,
  fake: 'fake-1',
});

const BACKENDS: readonly BackendName[] = ['auto', 'claude-cli', 'codex-cli', 'anthropic', 'openai-compat', 'fake'];

export function isBackendName(v: unknown): v is BackendName {
  return typeof v === 'string' && (BACKENDS as readonly string[]).includes(v);
}

/** Backend from GLASSBOX_BACKEND, else 'auto'. */
export function resolveBackendName(env: NodeJS.ProcessEnv = process.env): BackendName {
  const v = env.GLASSBOX_BACKEND?.trim();
  if (!v) return 'auto';
  if (!isBackendName(v)) throw new Error(`unknown GLASSBOX_BACKEND "${v}"; expected one of ${BACKENDS.join(', ')}`);
  return v;
}

/** Model for a concrete backend: GLASSBOX_MODEL, else the backend default (may be undefined). */
export function resolveModel(backend: Exclude<BackendName, 'auto'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.GLASSBOX_MODEL?.trim();
  return v ? v : DEFAULT_MODELS[backend];
}
