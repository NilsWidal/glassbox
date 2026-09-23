import { describe, expect, it } from 'vitest';
import { mean, median, renderMarkdown, summarize, type ResultsFile } from '../../bench/ab/src/report.ts';
import type { RunRecord } from '../../bench/ab/src/runner.ts';

function rec(taskId: string, arm: 'baseline' | 'ambient', success: boolean, cost: number, tools: number, words: number, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    taskId,
    repo: 'r',
    kind: 'question',
    arm,
    agent: 'claude',
    repeat: 0,
    success,
    checks: [],
    exitCode: 0,
    timedOut: false,
    wallMs: 1000 * tools,
    answerChars: words * 5,
    answerWords: words,
    answer: '',
    metrics: { isError: false, toolCalls: tools, toolsByName: {}, costUsd: cost, totalTokens: 1000 * tools, outputTokens: 10 * words, numTurns: tools + 1 },
    ...extra,
  };
}

const runs = [
  rec('a', 'baseline', true, 0.02, 4, 100),
  rec('a', 'ambient', true, 0.01, 2, 80),
  rec('b', 'baseline', false, 0.03, 6, 50),
  rec('b', 'ambient', true, 0.04, 7, 60),
  rec('c', 'baseline', true, 0.01, 1, 10),
  rec('c', 'ambient', false, 0.01, 1, 10, { error: 'timed out after 600s' }),
];

describe('median and mean', () => {
  it('handle odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(mean([])).toBeUndefined();
  });
});

describe('summarize', () => {
  const s = summarize(runs, ['baseline', 'ambient']);

  it('counts passes, errors and per-arm medians', () => {
    const [base, amb] = s.arms;
    expect(base).toMatchObject({ arm: 'baseline', runs: 3, successes: 2, agentErrors: 0 });
    expect(amb).toMatchObject({ arm: 'ambient', runs: 3, successes: 2, agentErrors: 1 });
    expect(base?.median.toolCalls).toBe(4);
    expect(amb?.median.costUsd).toBe(0.01);
    expect(base?.totalCostUsd).toBeCloseTo(0.06);
  });

  it('pairs tasks and reports ambient minus baseline', () => {
    const p = s.paired!;
    expect(p).toMatchObject({ tasks: 3, ambientOnlyPass: 1, baselineOnlyPass: 1 });
    // tool calls: a -2, b +1, c 0
    expect(p.deltas.toolCalls).toEqual({ medianDelta: 0, ambientLower: 1, ambientHigher: 1, equal: 1, tasks: 3 });
    // words: a -20, b +10, c 0
    expect(p.deltas.answerWords?.medianDelta).toBe(0);
    expect(p.deltas.costUsd?.ambientLower).toBe(1);
  });

  it('skips pairing with one arm', () => {
    expect(summarize(runs.filter((r) => r.arm === 'baseline'), ['baseline']).paired).toBeUndefined();
  });
});

describe('renderMarkdown', () => {
  it('prints the label, caveats, the arm table, the paired table and every run', () => {
    const file: ResultsFile = {
      label: 'pilot, small n',
      date: '2026-09-23',
      agent: 'claude',
      model: 'haiku',
      agentVersion: '2.1.280 (Claude Code)',
      glassboxVersion: '0.1.0',
      arms: ['baseline', 'ambient'],
      repeats: 1,
      caveats: ['n is tiny'],
      settings: {},
      prep: [{ repo: 'r', arm: 'ambient', ok: true, wallMs: 12_000 }],
      runs,
      summary: summarize(runs, ['baseline', 'ambient']),
    };
    const md = renderMarkdown(file);
    expect(md).toContain('# A/B results: pilot, small n');
    expect(md).toContain('- n is tiny');
    expect(md).toContain('| baseline | 3 | 2/3 | 0 |');
    expect(md).toContain('Ambient passed where the baseline failed on 1; the baseline passed where ambient failed on 1.');
    expect(md).toContain('| tool calls | 0 | 1 | 1 | 1 |');
    expect(md).toContain('| c | ambient | 0 | no |');
    expect(md).toContain('timed out after 600s');
    expect(md).toContain('r: `glassbox init` for the ambient arm, ok, 12.0 s');
    expect(md).not.toContain('—');
  });
});
