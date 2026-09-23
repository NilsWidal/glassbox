import { describe, expect, it } from 'vitest';
import { buildSummary } from '../../src/explain/summary.js';
import type { Chunk } from '../../src/scope.js';
import type { GraphEdge, GraphNode, Highlight } from '../../src/types.js';

const node = (id: string, name: string, startLine: number, endLine: number): GraphNode => ({
  id,
  kind: 'function',
  file: 'src/auth/session.ts',
  name,
  startLine,
  endLine,
  hash: 'h',
  lang: 'typescript',
});
const nodes = [
  node('s#login', 'login', 48, 52),
  node('s#verifySession', 'verifySession', 38, 46),
  node('s#issueToken', 'issueToken', 32, 36),
];
const edges: GraphEdge[] = [
  { from: 's#login', to: 's#verifySession', kind: 'calls' },
  { from: 's#login', to: 's#issueToken', kind: 'calls' },
];
const chunks: Chunk[] = [
  { id: 'c1', file: 'src/auth/session.ts', startLine: 38, endLine: 45, text: '', nodeId: 's#verifySession' },
  { id: 'c2', file: 'src/auth/session.ts', startLine: 32, endLine: 36, text: '', nodeId: 's#issueToken' },
  { id: 'c3', file: 'src/auth/session.ts', startLine: 11, endLine: 12, text: '' },
];
const h = (startLine: number, endLine: number, deltaP: number, comment?: string): Highlight => ({
  file: 'src/auth/session.ts',
  startLine,
  endLine,
  deltaP,
  kind: 'causal',
  ...(comment ? { comment } : {}),
});

describe('buildSummary', () => {
  it('renders the call path through highlighted functions', () => {
    const lines = buildSummary({
      highlights: [h(38, 45, -0.61, 'TTL now read from env'), h(32, 36, -0.1)],
      reasons: [],
      chunks,
      nodes,
      edges,
    });
    expect(lines[0]).toMatch(/^login\(\) -> verifySession\(\)\s+# TTL now read from env$/);
    expect(lines[1]).toMatch(/^ {8}-> issueToken\(\)\s+# Δp -0\.10 at src\/auth\/session\.ts:32-36$/);
    // Comments line up.
    expect(lines[0]!.indexOf('#')).toBe(lines[1]!.indexOf('#'));
  });

  it('lists highlights outside any function by span, and reasons by threshold', () => {
    const lines = buildSummary({
      highlights: [h(11, 12, -0.4)],
      reasons: [
        { code: 'reads-config', p: 0.91, kind: 'causal' },
        { code: 'side-effects', p: 0.4, kind: 'causal' },
        { code: 'missing-check', p: 0.05, kind: 'causal' },
      ],
      chunks,
      nodes,
      edges,
    });
    expect(lines).toEqual([
      'src/auth/session.ts:11-12   # Δp -0.40',
      'because: reads-config (p=0.91)',
      'ruled out: missing-check (p=0.05)',
    ]);
  });

  it('only uses numbers that are in the highlights or reasons', () => {
    const lines = buildSummary({ highlights: [h(38, 45, -0.61)], reasons: [{ code: 'x', p: 0.8, kind: 'causal' }], chunks, nodes, edges });
    const numbers = lines.join('\n').match(/\d+\.\d+/g) ?? [];
    expect(new Set(numbers)).toEqual(new Set(['0.61', '0.80']));
  });

  it('shows a lone highlighted function without a caller', () => {
    expect(buildSummary({ highlights: [h(38, 45, -0.3, 'expires old sessions')], reasons: [], chunks, nodes, edges: [] })).toEqual([
      'verifySession()   # expires old sessions',
    ]);
  });
});
