import { execFileSync } from 'node:child_process';
import type { FakeRule } from '../../src/backends/fake.js';
import { main, type CliIo } from '../../src/cli/index.js';
import { fixtureCopy, tagRule } from '../query/helpers.js';

export const rules: FakeRule[] = [
  tagRule,
  (ctx) =>
    ctx.question.instructions.startsWith('How risky is')
      ? ctx.text.includes('expiresAt')
        ? { '2': 0.97, '1': 0.02, '0': 0.01 }
        : { '0': 0.97, '1': 0.02, '2': 0.01 }
      : undefined,
];

export interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in-process with the fake backend. */
export async function cli(root: string, args: string[], extra: Partial<CliIo> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: async () => '',
    env: { GLASSBOX_BACKEND: 'fake' },
    cwd: root,
    backendConfig: { fake: { rules } },
    // Never start a real background worker from a test.
    spawnDetached: () => {},
    ...extra,
  };
  const code = await main(args, io);
  return { code, out: out.join(''), err: err.join('') };
}

/** A temp copy of the sample repo with `glassbox init` run (fake tags), optionally a git repo. */
export async function indexedFixture(opts: { git?: boolean } = {}): Promise<string> {
  const root = await fixtureCopy();
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  }
  const r = await cli(root, ['init', '--quiet', '--group-size', '8', '--no-claude-md']);
  if (r.code !== 0) throw new Error(`init failed: ${r.err}`);
  if (opts.git) {
    // Commit what init wrote (AGENTS.md), so the working diff starts empty.
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'glassbox'], { cwd: root, stdio: 'ignore' });
  }
  return root;
}

export function percentile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
}
