import { resolveBackendName, resolveModel } from '../config.js';
import type { Backend, BackendName } from '../types.js';
import { AnthropicBackend, type AnthropicOptions } from './anthropic.js';
import { pickAutoBackend } from './auto.js';
import { ClaudeCliBackend, type ClaudeCliOptions } from './claude-cli.js';
import { CodexCliBackend, type CodexCliOptions } from './codex-cli.js';
import { FakeBackend, type FakeBackendOptions } from './fake.js';
import { OpenAICompatBackend, type OpenAICompatOptions } from './openai-compat.js';
import { checkModelId } from './process.js';

export interface BackendConfig {
  /** Default GLASSBOX_BACKEND, else 'auto'. */
  backend?: BackendName;
  /** Default GLASSBOX_MODEL, else the backend's default. */
  model?: string;
  /** Samples per call for sampling backends. Default GLASSBOX_SAMPLES, else 3. */
  samples?: number;
  /** Per-call timeout. Default GLASSBOX_TIMEOUT_MS, else 120 s. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Backend-specific extras. */
  claudeCli?: ClaudeCliOptions;
  codexCli?: CodexCliOptions;
  anthropic?: AnthropicOptions;
  openaiCompat?: OpenAICompatOptions;
  fake?: FakeBackendOptions;
}

/** Concrete backend name for a config: resolves 'auto' to the host agent's CLI. */
export function resolveBackend(config: BackendConfig = {}): Exclude<BackendName, 'auto'> {
  const env = config.env ?? process.env;
  const name = config.backend ?? resolveBackendName(env);
  return name === 'auto' ? pickAutoBackend(env) : name;
}

/** Builds the backend chosen by config or GLASSBOX_BACKEND (default auto). */
export function createBackend(config: BackendConfig = {}): Backend {
  const env = config.env ?? process.env;
  const name = resolveBackend(config);
  const model = config.model ?? resolveModel(name, env);
  if (model !== undefined && name !== 'fake') checkModelId(model);
  const common = {
    env,
    ...(config.samples !== undefined ? { samples: config.samples } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
  const withModel = model !== undefined ? { model } : {};
  switch (name) {
    case 'claude-cli':
      return new ClaudeCliBackend({ ...common, ...withModel, ...config.claudeCli });
    case 'codex-cli':
      return new CodexCliBackend({ ...common, ...withModel, ...config.codexCli });
    case 'anthropic':
      return new AnthropicBackend({ ...common, ...withModel, ...config.anthropic });
    case 'openai-compat': {
      const { samples: _samples, ...rest } = common;
      return new OpenAICompatBackend({ ...rest, ...withModel, ...config.openaiCompat });
    }
    case 'fake':
      return new FakeBackend({ ...withModel, ...config.fake });
  }
}

export { AnthropicBackend, createAnthropicBackend, splitForCache } from './anthropic.js';
export type { AnthropicClientLike, AnthropicOptions } from './anthropic.js';
export { CODEX_ENV_MARKERS, NO_HOST_CLI_MESSAGE, detectHost, pickAutoBackend } from './auto.js';
export type { HostCli } from './auto.js';
export { ClaudeCliBackend, createClaudeCliBackend, parseEnvelope } from './claude-cli.js';
export type { ClaudeCliOptions } from './claude-cli.js';
export { CodexCliBackend, createCodexCliBackend } from './codex-cli.js';
export type { CodexCliOptions } from './codex-cli.js';
export { HttpError, MAX_GROUP, OpenAICompatBackend, createOpenAICompatBackend } from './openai-compat.js';
export type { OpenAICompatOptions } from './openai-compat.js';
export { CliCallError, CliNotFoundError, CliTimeoutError, findOnPath, runProcess } from './process.js';
export type { ProcessRunner, RunOptions, RunResult } from './process.js';
export { DEFAULT_SAMPLES, DEFAULT_TIMEOUT_MS, averageSamples, resolveSamples, resolveTimeoutMs } from './sampling.js';
