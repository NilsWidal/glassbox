import { randomBytes } from 'node:crypto';
import { findUserByEmail } from '../db.js';
import { comparePassword } from './password.js';

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

// Risky: TTL comes from the environment with no fallback, so it can be NaN.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL) * 1000;

export class SessionStore {
  private sessions = new Map<string, Session>();

  save(session: Session): void {
    this.sessions.set(session.token, session);
  }

  get(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  revoke(token: string): void {
    this.sessions.delete(token);
  }
}

export const store = new SessionStore();

export function issueToken(userId: string): Session {
  const session = { token: randomBytes(24).toString('hex'), userId, expiresAt: Date.now() + SESSION_TTL_MS };
  store.save(session);
  return session;
}

export function verifySession(token: string): Session | null {
  const session = store.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    store.revoke(token);
    return null;
  }
  return session;
}

export async function login(email: string, password: string): Promise<Session | null> {
  const user = findUserByEmail(email);
  if (!user || !comparePassword(password, String(user.passwordHash))) return null;
  return issueToken(String(user.id));
}
