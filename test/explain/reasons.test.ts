import { describe, expect, it } from 'vitest';
import { DEFAULT_REASONS, collectReasons, parseReasons, reasonQuestions } from '../../src/explain/reasons.js';

describe('reasons', () => {
  it('parses code=question, known codes and unknown codes', () => {
    const r = parseReasons(['reads-config', 'uses-cache=Does the code read from a cache?', 'custom']);
    expect(r[0]).toEqual(DEFAULT_REASONS.find((x) => x.code === 'reads-config'));
    expect(r[1]).toEqual({ code: 'uses-cache', question: 'Does the code read from a cache?' });
    expect(r[2]!.question).toContain('"custom"');
  });

  it('builds hidden yes/no questions framed by the main question', () => {
    const qs = reasonQuestions(parseReasons(['reads-config']), 'Does this change auth?');
    expect(qs['reason:reads-config']).toMatchObject({ type: 'yesno' });
    expect(qs['reason:reads-config']!.instructions).toContain('"Does this change auth?"');
  });

  it('collects causal reason codes, most likely first, skipping unanswered ones', () => {
    const specs = parseReasons(['a=A?', 'b=B?', 'c=C?']);
    const out = collectReasons(specs, { a: 0.2, b: 0.9 });
    expect(out).toEqual([
      { code: 'b', p: 0.9, kind: 'causal' },
      { code: 'a', p: 0.2, kind: 'causal' },
    ]);
  });
});
