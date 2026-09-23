/* global process */
import { check, load } from '../ts.mjs';

async function ttlMs(value, tag) {
  if (value === undefined) delete process.env.SESSION_TTL;
  else process.env.SESSION_TTL = value;
  const mod = await load('src/auth/session.ts', tag);
  const s = mod.issueToken('u1');
  return s.expiresAt - Date.now();
}

const near = (got, want) => Number.isFinite(got) && Math.abs(got - want) < 5000;
const unset = await ttlMs(undefined, 'a');
check(near(unset, 3600_000), `unset SESSION_TTL should give 3600 s, got ${unset} ms`);
const junk = await ttlMs('abc', 'b');
check(near(junk, 3600_000), `SESSION_TTL=abc should give 3600 s, got ${junk} ms`);
const neg = await ttlMs('-5', 'c');
check(near(neg, 3600_000), `SESSION_TTL=-5 should give 3600 s, got ${neg} ms`);
const set = await ttlMs('120', 'd');
check(near(set, 120_000), `SESSION_TTL=120 should give 120 s, got ${set} ms`);
