import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  END_MARKER,
  START_MARKER,
  renderBlock,
  syncAgentsMd,
  type AgentsMdSummary,
} from '../../src/agents-md/index.js';

const summary: AgentsMdSummary = {
  areas: [
    { name: 'auth', entryPoints: ['src/auth/session.ts:42', 'src/auth/middleware.ts:18'], nodeCount: 12 },
    { name: 'billing', entryPoints: ['src/billing/retry.ts:7'], nodeCount: 30 },
  ],
  riskyNodes: [
    { name: 'verifySession', file: 'src/auth/session.ts', line: 42, reason: 'TTL from env, no fallback', p: 0.91 },
  ],
  availableTags: ['touches-auth', 'io', 'pure'],
  generatedAt: '2026-09-22T10:00:00.000Z',
};

let dir: string;
const read = (name: string) => readFile(join(dir, name), 'utf8');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-agents-md-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('syncAgentsMd', () => {
  it('creates AGENTS.md and CLAUDE.md when neither exists', async () => {
    const res = await syncAgentsMd(dir, summary);
    expect(res.agentsMd).toBe('created');
    expect(res.claudeMd).toBe('created');
    const agents = await read('AGENTS.md');
    expect(agents.startsWith('# AGENTS.md\n')).toBe(true);
    expect(agents).toContain(START_MARKER);
    expect(agents).toContain(END_MARKER);
    expect(agents).toContain('**billing** (30 nodes)');
    expect(agents).toContain('`verifySession` src/auth/session.ts:42 p=0.91');
    expect(agents).toContain('`io`, `pure`, `touches-auth`');
    for (const tool of ['ask', 'where', 'triage', 'decide', 'explain', 'graph', 'refresh']) {
      expect(agents).toContain(`- \`${tool}\`:`);
    }
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  it('appends the block to an existing AGENTS.md without markers', async () => {
    const before = '# Project rules\n\nUse pnpm.\n';
    await writeFile(join(dir, 'AGENTS.md'), before);
    const res = await syncAgentsMd(dir, summary);
    expect(res.agentsMd).toBe('updated');
    const agents = await read('AGENTS.md');
    expect(agents.startsWith('# Project rules\n\nUse pnpm.\n\n' + START_MARKER)).toBe(true);
    expect(agents.endsWith(END_MARKER + '\n')).toBe(true);
  });

  it('replaces only the text between existing markers', async () => {
    const before = `intro\n\n${START_MARKER}\nold stuff\n${END_MARKER}\n\noutro line\n`;
    await writeFile(join(dir, 'AGENTS.md'), before);
    await syncAgentsMd(dir, summary);
    const agents = await read('AGENTS.md');
    expect(agents.startsWith(`intro\n\n${START_MARKER}\n## glassbox code map`)).toBe(true);
    expect(agents.endsWith(`${END_MARKER}\n\noutro line\n`)).toBe(true);
    expect(agents).not.toContain('old stuff');
  });

  it('refuses a start marker without an end marker', async () => {
    await writeFile(join(dir, 'AGENTS.md'), `x\n${START_MARKER}\nbroken\n`);
    await expect(syncAgentsMd(dir, summary)).rejects.toThrow(/without/);
    expect(await read('AGENTS.md')).toBe(`x\n${START_MARKER}\nbroken\n`);
  });

  it('preserves CRLF line endings in AGENTS.md and CLAUDE.md', async () => {
    await writeFile(join(dir, 'AGENTS.md'), `a\r\n\r\n${START_MARKER}\r\nold\r\n${END_MARKER}\r\nz\r\n`);
    await writeFile(join(dir, 'CLAUDE.md'), '# Claude\r\nrules\r\n');
    await syncAgentsMd(dir, summary);
    const agents = await read('AGENTS.md');
    expect(agents.replace(/\r\n/g, '')).not.toContain('\n');
    expect(agents.startsWith(`a\r\n\r\n${START_MARKER}\r\n`)).toBe(true);
    expect(agents.endsWith(`${END_MARKER}\r\nz\r\n`)).toBe(true);
    expect(await read('CLAUDE.md')).toBe('# Claude\r\nrules\r\n\r\n@AGENTS.md\r\n');
  });

  it('leaves CLAUDE.md alone when it already imports AGENTS.md', async () => {
    for (const form of ['@AGENTS.md', '@./AGENTS.md']) {
      const before = `# Claude\n${form}\nmore\n`;
      await writeFile(join(dir, 'CLAUDE.md'), before);
      const res = await syncAgentsMd(dir, summary);
      expect(res.claudeMd).toBe('unchanged');
      expect(await read('CLAUDE.md')).toBe(before);
    }
  });

  it('appends the import to CLAUDE.md that lacks it', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# Claude\nsee @AGENTS.md for more\n');
    const res = await syncAgentsMd(dir, summary);
    expect(res.claudeMd).toBe('updated');
    expect(await read('CLAUDE.md')).toBe('# Claude\nsee @AGENTS.md for more\n\n@AGENTS.md\n');
  });

  it('does not create CLAUDE.md when opted out', async () => {
    const res = await syncAgentsMd(dir, summary, { claudeMd: false });
    expect(res.claudeMd).toBe('skipped');
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(res.agentsMd).toBe('created');
  });

  it('is idempotent, even when only the timestamp moved', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'keep me\n');
    await syncAgentsMd(dir, summary);
    const agents1 = await read('AGENTS.md');
    const claude1 = await read('CLAUDE.md');
    const res = await syncAgentsMd(dir, { ...summary, generatedAt: '2026-09-23T00:00:00.000Z' });
    expect(res.agentsMd).toBe('unchanged');
    expect(res.claudeMd).toBe('unchanged');
    expect(await read('AGENTS.md')).toBe(agents1);
    expect(await read('CLAUDE.md')).toBe(claude1);
  });

  it('rewrites the block when content changes', async () => {
    await syncAgentsMd(dir, summary);
    const res = await syncAgentsMd(dir, { ...summary, availableTags: ['new-tag'] });
    expect(res.agentsMd).toBe('updated');
    const agents = await read('AGENTS.md');
    expect(agents).toContain('`new-tag`');
    expect(agents.split(START_MARKER)).toHaveLength(2);
  });

  it('caps the block and truncates lists with a where hint', async () => {
    const big: AgentsMdSummary = {
      areas: Array.from({ length: 40 }, (_, i) => ({
        name: `area${i}`,
        entryPoints: [`src/a${i}.ts:1`, `src/b${i}.ts:2`, `src/c${i}.ts:3`, `src/d${i}.ts:4`],
        nodeCount: 100 - i,
      })),
      riskyNodes: Array.from({ length: 40 }, (_, i) => ({
        name: `fn${i}`,
        file: `src/f${i}.ts`,
        line: i + 1,
        reason: 'r'.repeat(300),
        p: i / 40,
      })),
      availableTags: Array.from({ length: 50 }, (_, i) => `tag${i}`),
      generatedAt: summary.generatedAt,
    };
    const res = await syncAgentsMd(dir, big);
    expect(res.truncated).toBe(true);
    expect(res.lines).toBeLessThanOrEqual(60);
    const agents = await read('AGENTS.md');
    const block = agents.slice(agents.indexOf(START_MARKER), agents.indexOf(END_MARKER) + END_MARKER.length);
    expect(block.split('\n').length).toBeLessThanOrEqual(60);
    expect(block).toMatch(/\(\+\d+ more, query with glassbox where\)/);
    expect(block).toContain('`area0`'.replace(/`/g, '**'));
    expect(block).toContain('+1 more');
    expect(block).toContain('`fn39`'); // highest p first
    expect(block).not.toContain('r'.repeat(101));
  });
});

describe('renderBlock', () => {
  it('renders empty sections and strips marker-like text', () => {
    const r = renderBlock({
      areas: [],
      riskyNodes: [{ name: 'x', file: 'a.ts', line: 1, reason: `evil ${END_MARKER}`, p: 2 }],
      availableTags: [],
      generatedAt: 'now',
    });
    expect(r.text.split(END_MARKER)).toHaveLength(2);
    expect(r.text).toContain('p=1.00');
    expect(r.text).toContain('none yet');
    expect(r.truncated).toBe(false);
  });
});
