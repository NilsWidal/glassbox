// Success checks: a regex on the final answer, or a command run in the workspace.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunProc } from './proc.ts';
import type { Check } from './tasks.ts';

export interface CheckResult {
  type: Check['type'];
  label: string;
  pass: boolean;
  detail?: string;
}

const tail = (s: string, n = 400) => (s.length > n ? `...${s.slice(-n)}` : s).trim();

/** Fills `{checks}` and `{answerFile}` in a check's argv. */
export function expandArgv(argv: string[], vars: { checks: string; answerFile: string }): string[] {
  return argv.map((a) => a.replaceAll('{checks}', vars.checks).replaceAll('{answerFile}', vars.answerFile));
}

/**
 * Runs every check (all must pass). Command checks run without a shell, in the workspace,
 * with a clean environment apart from PATH and HOME.
 */
export async function runChecks(
  checks: Check[],
  ctx: { workspace: string; answer: string; checksDir: string; scratchDir: string; run: RunProc },
): Promise<CheckResult[]> {
  const answerFile = join(ctx.scratchDir, 'answer.txt');
  writeFileSync(answerFile, ctx.answer);
  const out: CheckResult[] = [];
  for (const c of checks) {
    if (c.type === 'answer') {
      const pass = new RegExp(c.pattern, c.flags).test(ctx.answer);
      out.push({ type: 'answer', label: `/${c.pattern}/${c.flags ?? ''}`, pass });
      continue;
    }
    const argv = expandArgv(c.argv, { checks: ctx.checksDir, answerFile });
    const [cmd, ...args] = argv as [string, ...string[]];
    const r = await ctx.run({
      cmd,
      args,
      cwd: ctx.workspace,
      timeoutMs: (c.timeoutSec ?? 120) * 1000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PYTHONDONTWRITEBYTECODE: '1',
        NODE_NO_WARNINGS: '1',
      },
    });
    const pass = r.code === 0 && !r.timedOut;
    out.push({
      type: 'command',
      label: c.argv.join(' '),
      pass,
      ...(pass ? {} : { detail: r.timedOut ? 'timed out' : tail(r.spawnError ?? `${r.stderr}\n${r.stdout}`) }),
    });
  }
  return out;
}
