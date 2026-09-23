import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexCliBackend } from '../../src/backends/codex-cli.js';
import { CliNotFoundError } from '../../src/backends/process.js';
import { answer, batch, fakeRunner, type Call } from './helpers.js';

const flag = (c: Call, name: string) => c.args[c.args.indexOf(name) + 1]!;

/** Writes `text` to the -o file, as codex does. */
const writesLast = (text: string) => (c: Call) => {
  writeFileSync(flag(c, '-o'), text);
  return { stdout: 'noise' };
};

describe('CodexCliBackend', () => {
  it('runs codex exec with schema file, read-only sandbox and prompt on stdin', async () => {
    let schema: { required?: string[] } = {};
    const { run, calls } = fakeRunner((c) => {
      schema = JSON.parse(readFileSync(flag(c, '--output-schema'), 'utf8'));
      return writesLast(JSON.stringify(answer(0.1, [0, 1, 0])))(c);
    });
    const out = await new CodexCliBackend({ run, samples: 1 }).answerBatch('const x = 1', batch);

    const c = calls[0]!;
    expect(c.cmd).toBe('codex');
    expect(c.args[0]).toBe('exec');
    expect(c.args).toContain('--skip-git-repo-check');
    expect(flag(c, '--sandbox')).toBe('read-only');
    expect(c.args.at(-1)).toBe('-');
    expect(c.args).not.toContain('-m');
    expect(c.args).toContain('model_reasoning_effort="low"');
    expect(c.opts.input).toContain('const x = 1');
    expect(c.opts.env?.GLASSBOX_NESTED).toBe('1');
    expect(schema.required).toEqual(['q1', 'q2']);
    expect(out.sideEffects!.A).toBeCloseTo(0.1);
    expect(out.kind!.B).toBeCloseTo(1);
    // The temp dir is cleaned up.
    expect(existsSync(flag(c, '-C'))).toBe(false);
  });

  it('turns off the shell and other tools in the nested run and caps free text', async () => {
    const { run, calls } = fakeRunner(writesLast('x'.repeat(5000)));
    const b = new CodexCliBackend({ run, samples: 1, env: { GLASSBOX_OPENAI_API_KEY: 'k', PATH: '/bin' } });
    expect((await b.generate('why?')).length).toBe(2000);
    const c = calls[0]!;
    expect(c.args).toContain('features.shell_tool=false');
    expect(c.args).toContain('features.unified_exec=false');
    expect(c.opts.env?.GLASSBOX_OPENAI_API_KEY).toBeUndefined();
    expect(() => new CodexCliBackend({ run, model: '-c' })).toThrow(/invalid model id/);
  });

  it('passes -m only when a model is set', async () => {
    const { run, calls } = fakeRunner(writesLast(JSON.stringify(answer(0.5, [1, 1, 1]))));
    await new CodexCliBackend({ run, samples: 1, model: 'some-small-model' }).answerBatch('s', batch);
    expect(flag(calls[0]!, '-m')).toBe('some-small-model');
  });

  it('averages K samples', async () => {
    const ys = [0.2, 0.4, 0.9];
    const { run, calls } = fakeRunner((c, n) => writesLast(JSON.stringify(answer(ys[n]!, [1, 0, 0])))(c));
    const out = await new CodexCliBackend({ run, samples: 3 }).answerBatch('s', batch);
    expect(calls).toHaveLength(3);
    expect(out.sideEffects!.A).toBeCloseTo(0.5);
  });

  it('reports a missing CLI and a missing login clearly', async () => {
    const missing = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    await expect(new CodexCliBackend({ run: missing, samples: 1 }).answerBatch('s', batch)).rejects.toBeInstanceOf(CliNotFoundError);

    const { run } = fakeRunner(() => ({ code: 1, stderr: 'Error: Not logged in. Run codex login.' }));
    await expect(new CodexCliBackend({ run, samples: 1 }).answerBatch('s', batch)).rejects.toThrow(/codex login/);
  });

  it('drops --ephemeral on an older CLI and retries', async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args.includes('--ephemeral')
        ? { code: 2, stderr: "error: unexpected argument '--ephemeral' found" }
        : writesLast(JSON.stringify(answer(0.7, [1, 0, 0])))(c),
    );
    const out = await new CodexCliBackend({ run, samples: 1 }).answerBatch('s', batch);
    expect(calls).toHaveLength(2);
    expect(out.sideEffects!.A).toBeCloseTo(0.7);
  });

  it('generate returns the last message without a schema', async () => {
    const { run, calls } = fakeRunner(writesLast('  it reads the TTL from env \n'));
    expect(await new CodexCliBackend({ run }).generate('why?')).toBe('it reads the TTL from env');
    expect(calls[0]!.args).not.toContain('--output-schema');
  });
});
