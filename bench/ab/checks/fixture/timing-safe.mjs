import { readFileSync } from 'node:fs';
import { check, load } from '../ts.mjs';

const src = readFileSync('src/auth/password.ts', 'utf8');
check(src.includes('timingSafeEqual'), 'password.ts should use timingSafeEqual');
const { comparePassword, hashPassword } = await load('src/auth/password.ts');
const stored = hashPassword('secret');
check(comparePassword('secret', stored) === true, 'the right password should match');
check(comparePassword('Secret', stored) === false, 'a wrong password should not match');
let threw = false;
let short;
try {
  short = comparePassword('secret', 'abc');
} catch {
  threw = true;
}
check(!threw && short === false, 'a stored hash of another length should return false, not throw');
