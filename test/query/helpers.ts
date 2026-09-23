import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeRule, FakeRuleResult } from '../../src/backends/fake.js';
import { areaOf } from '../../src/memory/tags.js';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-repo');

/** A temp copy of the sample repo, so .glassbox/, AGENTS.md and CLAUDE.md never land in the fixture. */
export async function fixtureCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glassbox-repo-'));
  await cp(FIXTURE, root, { recursive: true });
  return root;
}

/** The file of the node a tag question is about: from a grouped question's header, else the state's first header. */
function fileOf(instructions: string, text: string): string {
  const m = /the header "([^":]+):/.exec(instructions) ?? /^### ([^:\n]+):/m.exec(text);
  return m?.[1] ?? '';
}

function nodeText(instructions: string, text: string): string {
  const m = /the header "([^"]+)"/.exec(instructions);
  if (!m) return text;
  const start = text.indexOf(`### ${m[1]}`);
  if (start < 0) return text;
  const next = text.indexOf('\n### ', start + 4);
  return text.slice(start, next < 0 ? undefined : next);
}

const AUTH = /session|password|auth|login|token/i;
const MONEY = /charge|invoice|amount|card/i;

/**
 * Plausible scripted tags: auth-looking code handles auth and is High risk,
 * money code is High risk with side effects, the rest is Low risk. Works for
 * single and grouped tag states.
 */
export const tagRule: FakeRule = (ctx): FakeRuleResult => {
  const sep = ctx.questionId.indexOf('|');
  if (sep < 0) return undefined;
  const qid = ctx.questionId.slice(sep + 1);
  const body = nodeText(ctx.question.instructions, ctx.text);
  const auth = AUTH.test(body);
  const money = MONEY.test(body);
  switch (qid) {
    case 'handles_auth':
      return auth ? 0.9 : 0.1;
    case 'side_effects':
      return money ? 0.8 : 0.2;
    case 'touches_pii':
      return /email|password|card/i.test(body) ? 0.85 : 0.1;
    case 'needs_tests':
      return auth || money ? 0.8 : 0.3;
    case 'area': {
      const area = areaOf(fileOf(ctx.question.instructions, ctx.text)) ?? 'other';
      return ctx.options.includes(area) ? { [area]: 0.9, other: 0.1 } : { other: 1 };
    }
    case 'risk':
      return auth || money ? { '0': 0.05, '1': 0.15, '2': 0.8 } : { '0': 0.8, '1': 0.15, '2': 0.05 };
    default:
      return undefined;
  }
};
