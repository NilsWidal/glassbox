import { describe, expect, it } from 'vitest';
import { ClaudeCliBackend } from '../../src/backends/claude-cli.js';
import { CodexCliBackend } from '../../src/backends/codex-cli.js';
import { findOnPath } from '../../src/backends/process.js';
import type { Backend } from '../../src/types.js';
import { batch } from './helpers.js';

// Opt-in: GLASSBOX_IT=1 runs ONE tiny real call per host CLI (K=1).
const live = process.env.GLASSBOX_IT === '1';
const STATE = 'function add(a, b) {\n  return a + b;\n}';

async function check(backend: Backend) {
  const t0 = performance.now();
  const out = await backend.answerBatch(STATE, batch);
  const ms = Math.round(performance.now() - t0);
  console.log(`[live] ${backend.name} (${backend.model ?? 'default model'}): ${ms} ms`, JSON.stringify(out));
  for (const id of ['sideEffects', 'kind']) {
    const dist = out[id]!;
    expect(dist).toBeDefined();
    expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  }
  // A pure add() has no side effects: label B is "no".
  expect(out.sideEffects!.B!).toBeGreaterThan(0.5);
}

describe.skipIf(!live || !findOnPath('claude'))('live claude-cli', () => {
  it('answers a batch through claude -p', async () => {
    await check(new ClaudeCliBackend({ samples: 1 }));
  });
});

describe.skipIf(!live || !findOnPath('codex'))('live codex-cli', () => {
  it('answers a batch through codex exec', async () => {
    await check(new CodexCliBackend({ samples: 1, ...(process.env.GLASSBOX_MODEL ? { model: process.env.GLASSBOX_MODEL } : {}) }));
  });
});
