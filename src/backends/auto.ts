import { findOnPath } from './process.js';

export type HostCli = 'claude-cli' | 'codex-cli';

/**
 * Env vars Codex sets for the commands it runs (checked on codex-cli 0.154).
 * MCP servers may get a filtered env, so PATH lookup remains the fallback.
 */
export const CODEX_ENV_MARKERS = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_SANDBOX', 'CODEX_CI'] as const;

export const NO_HOST_CLI_MESSAGE = [
  'glassbox found no host agent CLI to run on.',
  'It uses the model of the agent you already have, with its existing login:',
  '  - Claude Code: install `claude` and log in (GLASSBOX_BACKEND=claude-cli)',
  '  - Codex: install `codex` and run `codex login` (GLASSBOX_BACKEND=codex-cli)',
  'For CI or headless use, set GLASSBOX_BACKEND=anthropic with ANTHROPIC_API_KEY,',
  'or GLASSBOX_BACKEND=openai-compat with OPENAI_API_KEY and GLASSBOX_MODEL.',
].join('\n');

/** Which host we are running inside, from its env markers. */
export function detectHost(env: NodeJS.ProcessEnv = process.env): HostCli | undefined {
  if (env.CLAUDECODE) return 'claude-cli';
  if (CODEX_ENV_MARKERS.some((k) => env[k])) return 'codex-cli';
  return undefined;
}

/**
 * Picks the backend for `auto`: the host agent's own CLI, else the first of
 * claude / codex on PATH. Throws with setup options when neither is found.
 */
export function pickAutoBackend(
  env: NodeJS.ProcessEnv = process.env,
  onPath: (cmd: string) => boolean = (cmd) => findOnPath(cmd, env) !== undefined,
): HostCli {
  const host = detectHost(env);
  if (host) return host;
  if (onPath(env.GLASSBOX_CLAUDE_BIN ?? 'claude')) return 'claude-cli';
  if (onPath(env.GLASSBOX_CODEX_BIN ?? 'codex')) return 'codex-cli';
  throw new Error(NO_HOST_CLI_MESSAGE);
}
