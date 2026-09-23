import { batchForPermutation } from '../../src/engine/decide.js';
import type { ProcessRunner, RunOptions, RunResult } from '../../src/backends/process.js';
import type { Question } from '../../src/types.js';

export const questions: Record<string, Question> = {
  sideEffects: { type: 'yesno', instructions: 'Does this function have side effects?' },
  kind: { type: 'choice', instructions: 'What kind of code is this?', criteria: { util: 'helper', io: 'I/O', ui: 'UI' } },
};

export const batch = batchForPermutation(questions, 0, 0);

export interface Call {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

/** A fake ProcessRunner that records calls and answers from a script. */
export function fakeRunner(respond: (call: Call, n: number) => Partial<RunResult> | Promise<Partial<RunResult>>): {
  run: ProcessRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: ProcessRunner = async (cmd, args, opts = {}) => {
    const call = { cmd, args: [...args], opts };
    calls.push(call);
    const r = await respond(call, calls.length - 1);
    return { code: 0, stdout: '', stderr: '', ...r };
  };
  return { run, calls };
}

/** JSON answer keyed by prompt keys q1, q2 for `batch`. */
export function answer(yes: number, kind: [number, number, number]) {
  return { q1: { A: yes, B: 1 - yes }, q2: { A: kind[0], B: kind[1], C: kind[2] } };
}
