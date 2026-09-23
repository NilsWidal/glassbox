// How each agent CLI is started for one run, and how its JSON output is read.

export type AgentName = 'claude' | 'codex';
export type Arm = 'baseline' | 'ambient';

export interface AgentOptions {
  agent: AgentName;
  arm: Arm;
  model?: string;
  /** The glassbox checkout loaded as a Claude Code plugin in the ambient arm. */
  pluginDir: string;
  /** Per-run spend cap passed to `claude -p --max-budget-usd`. */
  maxBudgetUsd?: number;
  /** Codex reasoning effort (`-c model_reasoning_effort=...`). */
  codexEffort?: string;
  /** Tools Claude may use without asking (the run is headless, so anything else is denied). */
  allowedTools?: string[];
  /** Also select the glassbox:concise output style in the ambient arm. */
  concise?: boolean;
  /** Also turn the end-of-turn gate on in the ambient arm. */
  gate?: boolean;
  bin?: string;
}

export interface AgentCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
}

/** Everything read from one agent run's output. Absent numbers mean the CLI did not report them. */
export interface AgentMetrics {
  answer: string;
  isError: boolean;
  errorText?: string;
  numTurns?: number;
  costUsd?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  durationApiMs?: number;
  toolCalls: number;
  toolsByName: Record<string, number>;
  permissionDenials?: number;
  /** What was denied, as `Tool: command` (cut at 120 characters), so the tool list can be tuned. */
  denied?: string[];
  /** Characters of glassbox context the UserPromptSubmit hook added (Claude only). */
  ambientChars?: number;
  /** The model the CLI reported, when it did. */
  model?: string;
  /** Plugins the session loaded (Claude only), to confirm each arm got what it should. */
  plugins?: string[];
}

export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Edit',
  'MultiEdit',
  'Write',
  'TodoWrite',
  'Bash(python3:*)',
  'Bash(python:*)',
  'Bash(PYTHONPATH=src python3:*)',
  'Bash(PYTHONPATH=src python:*)',
  'Bash(env PYTHONPATH=src python3:*)',
  'Bash(node:*)',
  'Bash(cd:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(sed -n:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
];

/** Variables removed from the agent's environment so nothing from this shell leaks into a run. */
const SCRUB = /^(GLASSBOX_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_PROJECT_DIR$|CLAUDE_PLUGIN_|CODEX_SANDBOX|CODEX_THREAD)/;

export function agentEnv(base: NodeJS.ProcessEnv, opts: Pick<AgentOptions, 'arm' | 'gate' | 'agent'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!SCRUB.test(k) && v !== undefined) env[k] = v;
  if (opts.arm === 'ambient') {
    env.GLASSBOX_AMBIENT = '1';
    env.GLASSBOX_GATE = opts.gate ? '1' : '0';
    // No background re-tagging during a run: it would add model calls the metrics cannot see.
    env.GLASSBOX_HOOKS = '0';
    env.GLASSBOX_WORKER = '0';
    env.GLASSBOX_BACKEND = opts.agent === 'codex' ? 'codex-cli' : 'claude-cli';
  }
  return env;
}

/**
 * Builds the command line. The prompt goes on stdin, so no argument can be mistaken for it.
 *
 * Claude: `claude -p --output-format stream-json --verbose --include-hook-events`, with user
 * settings, user plugins and all MCP servers left out (`--setting-sources project,local
 * --strict-mcp-config`) so both arms start from the same clean setup. The ambient arm adds
 * `--plugin-dir <glassbox>`. stream-json carries the same final `result` event as
 * `--output-format json`, plus the tool calls and hook output needed for the metrics.
 *
 * Codex: `codex exec --json` in a workspace-write sandbox. Codex has no plugin directory, so
 * its ambient arm is the AGENTS.md block that `glassbox init` writes.
 */
export function buildAgentCommand(prompt: string, workspace: string, opts: AgentOptions, baseEnv: NodeJS.ProcessEnv): AgentCommand {
  const env = agentEnv(baseEnv, opts);
  if (opts.agent === 'claude') {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
      '--no-session-persistence',
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    for (const t of opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS) args.push('--allowedTools', t);
    if (opts.arm === 'ambient') {
      args.push('--plugin-dir', opts.pluginDir);
      if (opts.concise) args.push('--settings', JSON.stringify({ outputStyle: 'glassbox:concise' }));
    }
    return { cmd: opts.bin ?? 'claude', args, env, stdin: prompt };
  }
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', workspace];
  if (opts.model) args.push('-m', opts.model);
  if (opts.codexEffort) args.push('-c', `model_reasoning_effort=${opts.codexEffort}`);
  args.push('-');
  return { cmd: opts.bin ?? 'codex', args, env, stdin: prompt };
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const v = JSON.parse(s) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // Not JSON: a stray log line.
    }
  }
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function sumDefined(...xs: (number | undefined)[]): number | undefined {
  const d = xs.filter((x): x is number => x !== undefined);
  return d.length ? d.reduce((a, b) => a + b, 0) : undefined;
}

/** Reads `claude -p --output-format stream-json --verbose` output. Also accepts plain `--output-format json`. */
export function parseClaudeOutput(stdout: string): AgentMetrics {
  const events = jsonLines(stdout);
  const toolsByName: Record<string, number> = {};
  let toolCalls = 0;
  let ambientChars: number | undefined;
  let model: string | undefined;
  let plugins: string[] | undefined;
  let result: Record<string, unknown> | undefined;
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'init') {
      model = typeof e.model === 'string' ? e.model : undefined;
      if (Array.isArray(e.plugins)) plugins = e.plugins.map((p) => String(obj(p).name ?? '')).filter(Boolean);
    } else if (e.type === 'assistant') {
      const content = obj(e.message).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const block = obj(c);
          if (block.type === 'tool_use') {
            toolCalls++;
            const name = String(block.name ?? 'unknown');
            toolsByName[name] = (toolsByName[name] ?? 0) + 1;
          }
        }
      }
    } else if (e.type === 'system' && e.subtype === 'hook_response' && e.hook_event === 'UserPromptSubmit') {
      const raw = typeof e.output === 'string' ? e.output : typeof e.stdout === 'string' ? e.stdout : '';
      let ctx = '';
      try {
        ctx = String(obj(obj(JSON.parse(raw.trim() || '{}')).hookSpecificOutput).additionalContext ?? '');
      } catch {
        ctx = '';
      }
      ambientChars = (ambientChars ?? 0) + ctx.length;
    } else if (e.type === 'result') {
      result = e;
    }
  }
  if (!result) {
    return {
      answer: '',
      isError: true,
      errorText: 'no result event in the output',
      toolCalls,
      toolsByName,
      ...(ambientChars !== undefined ? { ambientChars } : {}),
      ...(model ? { model } : {}),
      ...(plugins ? { plugins } : {}),
    };
  }
  const usage = obj(result.usage);
  const input = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  const answer = typeof result.result === 'string' ? result.result : '';
  const isError = result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success');
  const denialList = Array.isArray(result.permission_denials) ? result.permission_denials : undefined;
  const denied = denialList?.map((d) => {
    const x = obj(d);
    const input = obj(x.tool_input);
    const what = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : '';
    return `${String(x.tool_name ?? 'unknown')}: ${what}`.slice(0, 120);
  });
  const m: AgentMetrics = {
    answer,
    isError,
    toolCalls,
    toolsByName,
  };
  if (isError) m.errorText = String(result.subtype ?? 'error');
  const set = <K extends keyof AgentMetrics>(k: K, v: AgentMetrics[K] | undefined) => {
    if (v !== undefined) m[k] = v;
  };
  set('numTurns', num(result.num_turns));
  set('costUsd', num(result.total_cost_usd));
  set('inputTokens', input);
  set('cacheReadTokens', cacheRead);
  set('cacheCreationTokens', cacheCreation);
  set('outputTokens', output);
  set('reasoningTokens', num(obj(usage.output_tokens_details).thinking_tokens));
  set('totalTokens', sumDefined(input, cacheRead, cacheCreation, output));
  set('durationMs', num(result.duration_ms));
  set('durationApiMs', num(result.duration_api_ms));
  set('permissionDenials', denialList?.length);
  if (denied?.length) m.denied = denied;
  set('ambientChars', ambientChars);
  set('model', model);
  set('plugins', plugins);
  return m;
}

const CODEX_TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/** Reads `codex exec --json` JSONL events. Codex reports tokens but no cost. */
export function parseCodexOutput(stdout: string): AgentMetrics {
  const toolsByName: Record<string, number> = {};
  let toolCalls = 0;
  let answer = '';
  let turns = 0;
  let input: number | undefined;
  let cached: number | undefined;
  let output: number | undefined;
  let reasoning: number | undefined;
  let errorText: string | undefined;
  for (const e of jsonLines(stdout)) {
    if (e.type === 'item.completed') {
      const item = obj(e.item);
      const type = String(item.type ?? '');
      if (type === 'agent_message' && typeof item.text === 'string') answer = item.text;
      if (CODEX_TOOL_ITEMS.has(type)) {
        toolCalls++;
        const name = type === 'mcp_tool_call' ? `mcp:${String(item.server ?? '')}/${String(item.tool ?? '')}` : type;
        toolsByName[name] = (toolsByName[name] ?? 0) + 1;
      }
    } else if (e.type === 'turn.completed') {
      turns++;
      const u = obj(e.usage);
      input = sumDefined(input, num(u.input_tokens));
      cached = sumDefined(cached, num(u.cached_input_tokens));
      output = sumDefined(output, num(u.output_tokens));
      reasoning = sumDefined(reasoning, num(u.reasoning_output_tokens));
    } else if (e.type === 'turn.failed' || e.type === 'error') {
      errorText = String(obj(e.error).message ?? e.message ?? e.type);
    }
  }
  const m: AgentMetrics = { answer, isError: turns === 0 || errorText !== undefined, toolCalls, toolsByName };
  if (m.isError) m.errorText = errorText ?? 'no turn.completed event in the output';
  if (turns) m.numTurns = turns;
  // Codex counts cached input inside input_tokens; report the uncached part like Claude does.
  if (input !== undefined) m.inputTokens = input - (cached ?? 0);
  if (cached !== undefined) m.cacheReadTokens = cached;
  if (output !== undefined) m.outputTokens = output;
  if (reasoning !== undefined) m.reasoningTokens = reasoning;
  const total = sumDefined(input, output);
  if (total !== undefined) m.totalTokens = total;
  return m;
}

export function parseAgentOutput(agent: AgentName, stdout: string): AgentMetrics {
  return agent === 'claude' ? parseClaudeOutput(stdout) : parseCodexOutput(stdout);
}

export function answerLength(text: string): { chars: number; words: number } {
  const t = text.trim();
  return { chars: t.length, words: t ? t.split(/\s+/).length : 0 };
}
