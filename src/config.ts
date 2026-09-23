import type { BackendName } from './types.js';

/**
 * Fixed default model per backend: none. glassbox never picks a model.
 * claude-cli mirrors the model selected in Claude Code (resolveClaudeModel,
 * at each call); codex-cli passes no -m, so Codex uses its configured model;
 * anthropic uses ANTHROPIC_MODEL or the Claude Code settings model when it is
 * an API id (resolveAnthropicModel) and otherwise asks for GLASSBOX_MODEL.
 * GLASSBOX_MODEL overrides all of them. Kept for library compatibility.
 */
export const DEFAULT_MODELS: Readonly<Record<Exclude<BackendName, 'auto'>, string | undefined>> = Object.freeze({
  'claude-cli': undefined,
  'codex-cli': undefined,
  anthropic: undefined,
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
