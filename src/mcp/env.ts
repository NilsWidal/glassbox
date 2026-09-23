/**
 * Claude Code exports plugin userConfig values to the MCP server as
 * CLAUDE_PLUGIN_OPTION_<KEY>. This maps them onto the GLASSBOX_* and API key
 * variables the backends read. Variables the user already set win.
 */
export const PLUGIN_OPTION_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_PLUGIN_OPTION_BACKEND: 'GLASSBOX_BACKEND',
  CLAUDE_PLUGIN_OPTION_MODEL: 'GLASSBOX_MODEL',
  CLAUDE_PLUGIN_OPTION_OPENAI_BASE_URL: 'GLASSBOX_OPENAI_BASE_URL',
  CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY: 'GLASSBOX_OPENAI_API_KEY',
  // A glassbox-only name, so the nested `claude -p` never sees it and keeps using the Claude Code login.
  CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'GLASSBOX_ANTHROPIC_API_KEY',
});

/**
 * GLASSBOX_HOST names the agent that launched the server. MCP servers often get
 * a filtered env without the host's own markers, so the plugin and the Codex
 * config set it explicitly and `auto` resolves to that host's CLI.
 */
const HOST_BACKEND: Readonly<Record<string, string>> = Object.freeze({
  'claude-code': 'claude-cli',
  codex: 'codex-cli',
});

export function withPluginOptions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const [from, to] of Object.entries(PLUGIN_OPTION_ENV)) {
    const v = env[from]?.trim();
    if (v && !env[to]?.trim()) out[to] = v;
  }
  const hostBackend = HOST_BACKEND[env.GLASSBOX_HOST?.trim() ?? ''];
  const backend = out.GLASSBOX_BACKEND?.trim();
  if (hostBackend && (!backend || backend === 'auto')) out.GLASSBOX_BACKEND = hostBackend;
  return out;
}

/** The repo the tools work on: GLASSBOX_ROOT, else the host's project dir, else cwd. */
export function defaultRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  const usable = (v: string | undefined) => {
    const t = v?.trim();
    // Skip a "${VAR}" placeholder that a host passed through without expanding.
    return t && !t.includes('${') ? t : undefined;
  };
  return usable(env.GLASSBOX_ROOT) ?? usable(env.CLAUDE_PROJECT_DIR) ?? cwd;
}
