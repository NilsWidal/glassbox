import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcRequest, ProcResult, RunProc } from '../../bench/ab/src/proc.ts';
import { runProc } from '../../bench/ab/src/proc.ts';

export const AB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'ab');

/** One line of `claude -p --output-format stream-json` per event. */
export function claudeStream(opts: {
  answer: string;
  tools?: string[];
  ambientContext?: string;
  cost?: number;
  turns?: number;
  subtype?: string;
  plugins?: string[];
}): string {
  const lines: unknown[] = [
    { type: 'system', subtype: 'init', model: 'claude-haiku-4-5', plugins: (opts.plugins ?? []).map((name) => ({ name })) },
  ];
  if (opts.ambientContext !== undefined) {
    lines.push({
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'UserPromptSubmit',
      output: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: opts.ambientContext } })}\n`,
    });
  }
  for (const [i, name] of (opts.tools ?? []).entries()) {
    lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] } });
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } });
  }
  lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: opts.answer }] } });
  lines.push({
    type: 'result',
    subtype: opts.subtype ?? 'success',
    is_error: (opts.subtype ?? 'success') !== 'success',
    result: opts.answer,
    num_turns: opts.turns ?? (opts.tools?.length ?? 0) + 1,
    total_cost_usd: opts.cost ?? 0.01,
    duration_ms: 1000,
    duration_api_ms: 800,
    permission_denials: [],
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, output_tokens_details: { thinking_tokens: 5 } },
  });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

export type FakeHandler = (req: ProcRequest) => Partial<ProcResult> | undefined | Promise<Partial<ProcResult> | undefined>;

/**
 * A RunProc that answers the calls a handler claims (the agent CLI, glassbox init) and runs
 * everything else (git, check commands) for real. Every request is recorded.
 */
export function fakeProc(handler: FakeHandler): { run: RunProc; calls: ProcRequest[] } {
  const calls: ProcRequest[] = [];
  const run: RunProc = async (req) => {
    calls.push(req);
    const r = await handler(req);
    if (r) return { code: 0, stdout: '', stderr: '', timedOut: false, wallMs: 5, ...r };
    return runProc(req);
  };
  return { run, calls };
}
