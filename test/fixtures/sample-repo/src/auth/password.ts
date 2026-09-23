import { createHash } from 'node:crypto';

// Risky: md5 without a salt is not a password hash.
export function hashPassword(password: string): string {
  return createHash('md5').update(password).digest('hex');
}

// Risky: early-exit comparison leaks timing.
export function comparePassword(password: string, stored: string): boolean {
  const hashed = hashPassword(password);
  if (hashed.length !== stored.length) return false;
  for (let i = 0; i < hashed.length; i++) {
    if (hashed[i] !== stored[i]) return false;
  }
  return true;
}
