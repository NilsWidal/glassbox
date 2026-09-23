import { verifySession } from './session.js';

export interface Request {
  headers: Record<string, string | undefined>;
  userId?: string;
}

export type Next = () => void;

// Risky: a request with no Authorization header skips the check entirely.
export const requireAuth = (req: Request, next: Next): boolean => {
  const header = req.headers['authorization'];
  if (!header) {
    next();
    return true;
  }
  const session = verifySession(header.replace('Bearer ', ''));
  if (!session) return false;
  req.userId = session.userId;
  next();
  return true;
};

export const requireAdmin = (req: Request, next: Next): boolean => {
  return requireAuth(req, () => {
    if (req.userId === 'admin') next();
  });
};
