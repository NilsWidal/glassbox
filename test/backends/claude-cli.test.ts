import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCliBackend, parseEnvelope } from '../../src/backends/claude-cli.js';
import { CliCallError, CliNotFoundError } from '../../src/backends/process.js';
import { answer, batch, fakeRunner } from './helpers.js';

const envelope = (structured: unknown) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured });

describe('ClaudeCliBackend', () => {
  it('spawns claude with an args array, schema, quiet flags and the prompt on stdin', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: envelope(answer(0.2, [0.7, 0.2, 0.1])) }));
    const home = mkdtempSync(join(tmpdir(), 'glassbox-cc-home-'));
    const b = new ClaudeCliBackend({ run, samples: 1, env: { PATH: '/bin', HOME: home, CLAUDE_PROJECT_DIR: home }, managedSettings: join(home, 'none.json') });
    await b.answerBatch('function add(a, b) { return a + b }', batch);

    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0]!;
    expect(cmd).toBe('claude');
    // Nothing selected anywhere: no --model at all, so Claude Code uses its own default.
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'json', '--json-schema']);
    expect(args).not.toContain('--model');
    const schema = JSON.parse(args[4]!);
    expect(schema.required).toEqual(['q1', 'q2']);
    expect(schema.properties.q2.required).toEqual(['A', 'B', 'C']);
    for (const f of ['--tools', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
      expect(args).toContain(f);
    }
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(opts.input).toContain('function add(a, b)');
    expect(opts.input).toContain('[q1]');
    expect(opts.env?.GLASSBOX_NESTED).toBe('1');
    expect(opts.env?.PATH).toBe('/bin');
    expect(opts.timeoutMs).toBeGreaterThan(0);
  });

  it('keeps glassbox-held API keys out of the nested call and rejects flag-like model ids', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: envelope(answer(0.5, [1, 0, 0])) }));
    const env = { PATH: '/bin', GLASSBOX_ANTHROPIC_API_KEY: 'a', GLASSBOX_OPENAI_API_KEY: 'b', CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'c', ANTHROPIC_API_KEY: 'mine' };
    await new ClaudeCliBackend({ run, samples: 1, env }).answerBatch('s', batch);
    const child = calls[0]!.opts.env!;
    expect(child.GLASSBOX_ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.GLASSBOX_OPENAI_API_KEY).toBeUndefined();
    expect(child.CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY).toBeUndefined();
    // A key the user exported themselves stays: that is their own claude setup.
    expect(child.ANTHROPIC_API_KEY).toBe('mine');
    expect(() => new ClaudeCliBackend({ run, model: '--dangerously-skip-permissions' })).toThrow(/invalid model id/);
    expect(() => new ClaudeCliBackend({ run, model: 'claude-haiku-4-5@20251001' })).not.toThrow();
  });

  it('uses the configured model and binary', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: envelope(answer(0.5, [1, 0, 0])) }));
    const b = new ClaudeCliBackend({ run, samples: 1, model: 'sonnet', env: { GLASSBOX_CLAUDE_BIN: '/opt/claude' } });
    await b.answerBatch('s', batch);
    expect(calls[0]!.cmd).toBe('/opt/claude');
    expect(calls[0]!.args[2]).toBe('sonnet');
  });

  it('maps prompt keys back to question ids', async () => {
    const { run } = fakeRunner(() => ({ stdout: envelope(answer(0.9, [0.1, 0.8, 0.1])) }));
    const out = await new ClaudeCliBackend({ run, samples: 1 }).answerBatch('s', batch);
    expect(out.sideEffects!.A).toBeCloseTo(0.9);
    expect(out.kind!.B).toBeCloseTo(0.8);
  });

  it('runs K samples in parallel and averages them', async () => {
    const answers = [answer(1, [1, 0, 0]), answer(0.5, [0, 1, 0]), answer(0, [0, 0, 2])];
    const { run, calls } = fakeRunner((_c, n) => ({ stdout: envelope(answers[n]) }));
    const out = await new ClaudeCliBackend({ run, env: { GLASSBOX_SAMPLES: '3' } }).answerBatch('s', batch);
    expect(calls).toHaveLength(3);
    expect(out.sideEffects!.A).toBeCloseTo(0.5);
    // The third sample sums to 2; it is normalized before averaging.
    expect(out.kind).toEqual({ A: 1 / 3, B: 1 / 3, C: 1 / 3 });
  });

  it('falls back to the result string when structured_output is missing', async () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: '```json\n' + JSON.stringify(answer(0.3, [0, 0, 1])) + '\n```' });
    const { run } = fakeRunner(() => ({ stdout }));
    const out = await new ClaudeCliBackend({ run, samples: 1 }).answerBatch('s', batch);
    expect(out.sideEffects!.A).toBeCloseTo(0.3);
  });

  it('uses surviving samples when some fail', async () => {
    const { run } = fakeRunner((_c, n) => (n === 0 ? { code: 1, stderr: 'boom' } : { stdout: envelope(answer(0.8, [1, 0, 0])) }));
    const out = await new ClaudeCliBackend({ run, samples: 2 }).answerBatch('s', batch);
    expect(out.sideEffects!.A).toBeCloseTo(0.8);
  });

  it('gives a clear error when the CLI is missing', async () => {
    const run = async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    };
    await expect(new ClaudeCliBackend({ run, samples: 1 }).answerBatch('s', batch)).rejects.toBeInstanceOf(CliNotFoundError);
  });

  it('gives a clear error when not logged in', async () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
    const { run } = fakeRunner(() => ({ stdout, code: 1 }));
    await expect(new ClaudeCliBackend({ run, samples: 1 }).answerBatch('s', batch)).rejects.toThrow(/not logged in/);
  });

  it('drops a flag an older CLI rejects and retries once', async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args.includes('--safe-mode')
        ? { code: 1, stderr: "error: unknown option '--safe-mode'" }
        : { stdout: envelope(answer(0.4, [1, 0, 0])) },
    );
    const b = new ClaudeCliBackend({ run, samples: 1 });
    const out = await b.answerBatch('s', batch);
    expect(out.sideEffects!.A).toBeCloseTo(0.4);
    expect(calls).toHaveLength(2);
    expect(b.args()).not.toContain('--safe-mode');
  });

  it('fails closed when the CLI rejects a flag that keeps the nested run tool-free', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 1, stderr: "error: unknown option '--setting-sources'" }));
    await expect(new ClaudeCliBackend({ run, samples: 1 }).answerBatch('s', batch)).rejects.toThrow(/Update Claude Code/);
    expect(calls).toHaveLength(1);
  });

  it('generate returns the text result without a schema', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: JSON.stringify({ type: 'result', is_error: false, result: ' reads env TTL \n' }) }));
    const text = await new ClaudeCliBackend({ run }).generate('why?');
    expect(text).toBe('reads env TTL');
    expect(calls[0]!.args).not.toContain('--json-schema');
  });

  it('returns nothing for an empty batch without spawning', async () => {
    const { run, calls } = fakeRunner(() => ({}));
    expect(await new ClaudeCliBackend({ run }).answerBatch('s', {})).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe('parseEnvelope', () => {
  it('reports non-JSON output', () => {
    expect(() => parseEnvelope('garbage', 'bad things', 1)).toThrow(CliCallError);
  });

  it('accepts an envelope on the last line', () => {
    const env = parseEnvelope('warning: x\n{"type":"result","is_error":false,"structured_output":{"q1":{}}}', '', 0);
    expect(env.structured_output).toEqual({ q1: {} });
  });
});
