import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_TOOLS, agentEnv, answerLength, buildAgentCommand, parseClaudeOutput, parseCodexOutput } from '../../bench/ab/src/agents.ts';
import { claudeStream } from './helpers.ts';

const env = { PATH: '/bin', HOME: '/h', GLASSBOX_MODE: 'strict', GLASSBOX_AMBIENT: '1', CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: '/p', LANG: 'C.UTF-8', OTHER: 'no' };

describe('buildAgentCommand', () => {
  it('runs claude headless with stream-json, a clean setup and the prompt on stdin', () => {
    const c = buildAgentCommand('fix the bug', '/ws', { agent: 'claude', arm: 'baseline', pluginDir: '/gb', model: 'haiku', maxBudgetUsd: 0.5 }, env);
    expect(c.cmd).toBe('claude');
    expect(c.stdin).toBe('fix the bug');
    expect(c.args).not.toContain('fix the bug');
    expect(c.args.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events']);
    for (const f of ['--strict-mcp-config', '--no-session-persistence']) expect(c.args).toContain(f);
    expect(c.args[c.args.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(c.args[c.args.indexOf('--model') + 1]).toBe('haiku');
    expect(c.args[c.args.indexOf('--max-budget-usd') + 1]).toBe('0.5');
    expect(c.args).not.toContain('--plugin-dir');
    // The baseline gets no glassbox switches and none of this shell's.
    expect(Object.keys(c.env).filter((k) => k.startsWith('GLASSBOX_'))).toEqual([]);
    expect(c.env.CLAUDECODE).toBeUndefined();
    expect(c.env.CLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(c.env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8' });
  });

  it('loads the plugin and turns ambient context on (gate, hooks and worker off) in the ambient arm', () => {
    const c = buildAgentCommand('p', '/ws', { agent: 'claude', arm: 'ambient', pluginDir: '/gb' }, env);
    expect(c.args[c.args.indexOf('--plugin-dir') + 1]).toBe('/gb');
    expect(c.args).not.toContain('--settings');
    expect(c.env).toMatchObject({ GLASSBOX_AMBIENT: '1', GLASSBOX_GATE: '0', GLASSBOX_HOOKS: '0', GLASSBOX_WORKER: '0', GLASSBOX_BACKEND: 'claude-cli' });
    expect(c.env.GLASSBOX_MODE).toBeUndefined();
  });

  it('adds the concise output style and the gate only when asked', () => {
    const c = buildAgentCommand('p', '/ws', { agent: 'claude', arm: 'ambient', pluginDir: '/gb', concise: true, gate: true }, env);
    expect(JSON.parse(c.args[c.args.indexOf('--settings') + 1] as string)).toEqual({ outputStyle: 'glassbox:concise' });
    expect(c.env.GLASSBOX_GATE).toBe('1');
    const base = buildAgentCommand('p', '/ws', { agent: 'claude', arm: 'baseline', pluginDir: '/gb', concise: true }, env);
    expect(base.args).not.toContain('--settings');
  });

  it('runs codex exec --json in a workspace-write sandbox', () => {
    const c = buildAgentCommand('p', '/ws', { agent: 'codex', arm: 'ambient', pluginDir: '/gb', model: 'm1', codexEffort: 'low' }, env);
    expect(c.cmd).toBe('codex');
    expect(c.args).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', '/ws', '-m', 'm1', '-c', 'model_reasoning_effort=low', '-']);
    expect(c.stdin).toBe('p');
    expect(c.env.GLASSBOX_BACKEND).toBe('codex-cli');
  });

  it('passes only an allowlisted environment, plus the login variables of the agent being run', () => {
    const shell = {
      PATH: '/bin',
      HOME: '/h',
      TMPDIR: '/t',
      GLASSBOX_GATE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CODEX_SANDBOX: 'seatbelt',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GITHUB_TOKEN: 'gh',
      NPM_TOKEN: 'npm',
      ANTHROPIC_API_KEY: 'ant',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      OPENAI_API_KEY: 'oai',
    };
    expect(agentEnv(shell, { arm: 'baseline', agent: 'claude' })).toEqual({
      PATH: '/bin',
      HOME: '/h',
      TMPDIR: '/t',
      ANTHROPIC_API_KEY: 'ant',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    });
    expect(agentEnv(shell, { arm: 'baseline', agent: 'codex' })).toEqual({ PATH: '/bin', HOME: '/h', TMPDIR: '/t', OPENAI_API_KEY: 'oai' });
    const amb = agentEnv(shell, { arm: 'ambient', agent: 'claude' });
    expect(amb.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(amb.GITHUB_TOKEN).toBeUndefined();
    expect(amb.GLASSBOX_AMBIENT).toBe('1');
  });

  it('allows no shell tool that can run other commands or write files through its flags', () => {
    const c = buildAgentCommand('p', '/ws', { agent: 'claude', arm: 'baseline', pluginDir: '/gb' }, env);
    const allowed = c.args.filter((_, i) => c.args[i - 1] === '--allowedTools');
    expect(allowed).toEqual(DEFAULT_ALLOWED_TOOLS);
    for (const risky of ['Bash(find:*)', 'Bash(sed -n:*)', 'Bash(sed:*)', 'Bash(xargs:*)', 'Bash(sh:*)', 'Bash(bash:*)']) {
      expect(allowed).not.toContain(risky);
    }
  });
});

describe('parseClaudeOutput', () => {
  it('reads the result, usage, tool calls, hook context and plugins', () => {
    const m = parseClaudeOutput(
      claudeStream({ answer: 'verifySession in src/auth/session.ts', tools: ['Read', 'Grep', 'Read'], ambientContext: 'x'.repeat(42), cost: 0.02, plugins: ['glassbox'] }),
    );
    expect(m).toMatchObject({
      answer: 'verifySession in src/auth/session.ts',
      isError: false,
      toolCalls: 3,
      toolsByName: { Read: 2, Grep: 1 },
      ambientChars: 42,
      costUsd: 0.02,
      numTurns: 4,
      inputTokens: 10,
      cacheCreationTokens: 100,
      cacheReadTokens: 1000,
      outputTokens: 50,
      reasoningTokens: 5,
      totalTokens: 1160,
      durationMs: 1000,
      durationApiMs: 800,
      permissionDenials: 0,
      model: 'claude-haiku-4-5',
      plugins: ['glassbox'],
    });
  });

  it('leaves ambientChars out when no prompt hook ran, and counts an empty hook as 0', () => {
    expect(parseClaudeOutput(claudeStream({ answer: 'a' })).ambientChars).toBeUndefined();
    const lines = claudeStream({ answer: 'a' }).replace(
      '\n',
      `\n${JSON.stringify({ type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', output: '' })}\n`,
    );
    expect(parseClaudeOutput(lines).ambientChars).toBe(0);
  });

  it('lists denied tool calls', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'x',
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'rm -rf build' } }, { tool_name: 'Write', tool_input: { file_path: '/etc/x' } }],
    });
    expect(parseClaudeOutput(line)).toMatchObject({ permissionDenials: 2, denied: ['Bash: rm -rf build', 'Write: /etc/x'] });
  });

  it('flags error results and missing results', () => {
    const budget = parseClaudeOutput(claudeStream({ answer: '', subtype: 'error_max_budget_usd' }));
    expect(budget.isError).toBe(true);
    expect(budget.errorText).toBe('error_max_budget_usd');
    const none = parseClaudeOutput('not json\n{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}\n');
    expect(none).toMatchObject({ isError: true, errorText: 'no result event in the output', toolCalls: 1 });
  });

  it('also reads a plain --output-format json object', () => {
    const m = parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi', num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(m).toMatchObject({ answer: 'hi', isError: false, costUsd: 0.001, totalTokens: 3, toolCalls: 0 });
  });
});

describe('parseCodexOutput', () => {
  // Shape recorded from codex-cli 0.154 `codex exec --json`.
  const out = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will count the entries.' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls src'", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls src'", exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'reasoning', text: 'hmm' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'glassbox', tool: 'where' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Seven' } },
    { type: 'turn.completed', usage: { input_tokens: 37347, cached_input_tokens: 30592, output_tokens: 49, reasoning_output_tokens: 7 } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');

  it('takes the last agent message as the answer and counts tool items', () => {
    const m = parseCodexOutput(out);
    expect(m).toMatchObject({
      answer: 'Seven',
      isError: false,
      numTurns: 1,
      toolCalls: 2,
      toolsByName: { command_execution: 1, 'mcp:glassbox/where': 1 },
      inputTokens: 37347 - 30592,
      cacheReadTokens: 30592,
      outputTokens: 49,
      reasoningTokens: 7,
      totalTokens: 37347 + 49,
    });
    expect(m.costUsd).toBeUndefined();
  });

  it('flags failed turns and empty output', () => {
    expect(parseCodexOutput(`${JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })}\n`)).toMatchObject({ isError: true, errorText: 'boom' });
    expect(parseCodexOutput('')).toMatchObject({ isError: true, errorText: 'no turn.completed event in the output' });
  });
});

describe('answerLength', () => {
  it('counts characters and words of the trimmed answer', () => {
    expect(answerLength('  two words \n')).toEqual({ chars: 9, words: 2 });
    expect(answerLength('   ')).toEqual({ chars: 0, words: 0 });
  });
});
