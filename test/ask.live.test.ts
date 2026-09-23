import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ask } from '../src/ask.js';
import { ClaudeCliBackend } from '../src/backends/claude-cli.js';
import { CodexCliBackend } from '../src/backends/codex-cli.js';
import { findOnPath } from '../src/backends/process.js';
import { renderPretty } from '../src/render.js';
import type { Backend } from '../src/types.js';

// Opt-in: GLASSBOX_IT=1 runs a few small real asks on the host CLIs (K=1, one option order).
const live = process.env.GLASSBOX_IT === '1';

const SOURCE = [
  "const TTL_MS = Number(process.env.SESSION_TTL) * 1000;",
  '',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
].join('\n');

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glassbox-live-'));
  await writeFile(join(root, 'a.ts'), SOURCE);
  return root;
}

async function check(backend: Backend, explain: boolean) {
  const root = await repo();
  const r = await ask({ paths: ['a.ts'] }, 'Does this code read an environment variable?', {
    backend,
    root,
    log: false,
    decide: { permutations: 1 },
    explain: explain ? { budget: 3 } : false,
    why: explain,
    reasons: [],
  });
  console.log(`[live] ${backend.name}\n${renderPretty(r)}`);
  expect(r.answer.type === 'yesno' && r.answer.p).toBeGreaterThan(0.5);
  if (explain) {
    expect(r.calls.explain).toBeLessThanOrEqual(3);
    // Hiding the env line should be the strongest evidence, if anything was highlighted.
    const top = r.explain?.highlights[0];
    if (top) expect(top.startLine).toBe(1);
  }
}

describe.skipIf(!live || !findOnPath('claude'))('live ask on claude-cli', () => {
  it('answers and explains a tiny file', async () => {
    await check(new ClaudeCliBackend({ samples: 1 }), true);
  });
});

describe.skipIf(!live || !findOnPath('codex'))('live ask on codex-cli', () => {
  it('answers a tiny file', async () => {
    await check(new CodexCliBackend({ samples: 1, ...(process.env.GLASSBOX_MODEL ? { model: process.env.GLASSBOX_MODEL } : {}) }), false);
  });
});
