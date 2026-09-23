import { describe, expect, it } from 'vitest';
import { ClaudeCliBackend } from '../../src/backends/claude-cli.js';
import { CodexCliBackend } from '../../src/backends/codex-cli.js';
import { findOnPath } from '../../src/backends/process.js';
import { loadBench, runBench } from '../../src/calibrate/bench.js';
import type { Backend } from '../../src/types.js';

// Opt-in: GLASSBOX_IT=1 runs 3 bench questions on each host CLI (K=1, one option order).
// The full live bench is `glassbox bench --backend claude-cli`, run by hand.
const live = process.env.GLASSBOX_IT === '1';

async function check(backend: Backend) {
  const r = await runBench(await loadBench(), { backend, limit: 3, permutations: 1, faithfulness: false });
  console.log(`[live bench] ${backend.name}: acc=${r.metrics.accuracy} p50=${r.latencyMs.p50}ms`);
  expect(r.answered).toBe(3);
  expect(r.metrics.accuracy).toBeGreaterThanOrEqual(2 / 3);
}

describe.skipIf(!live || !findOnPath('claude'))('live bench on claude-cli', () => {
  it('answers three bench questions', async () => {
    await check(new ClaudeCliBackend({ samples: 1 }));
  });
});

describe.skipIf(!live || !findOnPath('codex'))('live bench on codex-cli', () => {
  it('answers three bench questions', async () => {
    await check(new CodexCliBackend({ samples: 1, ...(process.env.GLASSBOX_MODEL ? { model: process.env.GLASSBOX_MODEL } : {}) }));
  });
});
