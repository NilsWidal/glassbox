import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCliBackend } from '../src/backends/claude-cli.js';
import { CodexCliBackend } from '../src/backends/codex-cli.js';
import { findOnPath } from '../src/backends/process.js';
import { indexRepo } from '../src/memory/source.js';
import { GraphStore } from '../src/memory/store.js';
import { tagPass } from '../src/memory/tags.js';
import { renderWhere } from '../src/query/render.js';
import { where } from '../src/query/where.js';
import type { Backend } from '../src/types.js';

// Opt-in: GLASSBOX_IT=1 tags two tiny functions and runs one where, on the host CLIs (K=1, one option order).
const live = process.env.GLASSBOX_IT === '1';

const AUTH = [
  "export function checkPassword(input: string, stored: string): boolean {",
  '  return input === stored;',
  '}',
].join('\n');
const UI = ['export function formatPrice(cents: number): string {', '  return `$${(cents / 100).toFixed(2)}`;', '}'].join('\n');

async function check(backend: Backend) {
  const root = await mkdtemp(join(tmpdir(), 'glassbox-live-q-'));
  await writeFile(join(root, 'auth.ts'), AUTH);
  await writeFile(join(root, 'format.ts'), UI);
  const store = new GraphStore(':memory:');
  try {
    await indexRepo(root, store);
    const decide = { permutations: 1 };
    // Two files and two functions, all in one call.
    const r = await tagPass(root, backend, { store, groupSize: 4, decide });
    console.log(`[live] ${backend.name} tags`, JSON.stringify({ asked: r.asked, calls: r.calls, failed: r.failed }));
    expect(r.failed).toEqual([]);
    expect(store.getTag('auth.ts#checkPassword', 'handles_auth')?.answer).toBe('true');
    expect(store.getTag('format.ts#formatPrice', 'handles_auth')?.answer).toBe('false');
    const w = await where('password check', { store, root, backend, decide });
    console.log(`[live] ${backend.name}\n${renderWhere(w)}`);
    expect(w.hits[0]?.nodeId).toBe('auth.ts#checkPassword');
  } finally {
    store.close();
  }
}

describe.skipIf(!live || !findOnPath('claude'))('live tags and where on claude-cli', () => {
  it('tags two functions and finds the password check', async () => {
    await check(new ClaudeCliBackend({ samples: 1 }));
  });
});

describe.skipIf(!live || !findOnPath('codex'))('live tags and where on codex-cli', () => {
  it('tags two functions and finds the password check', async () => {
    await check(new CodexCliBackend({ samples: 1, ...(process.env.GLASSBOX_MODEL ? { model: process.env.GLASSBOX_MODEL } : {}) }));
  });
});
