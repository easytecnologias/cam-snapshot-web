import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export type AuthUser = {
  id: string;
  tenantId: string;
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const raw = String(req.headers.authorization || '');
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'authentication_required' });
  try {
    req.user = jwt.verify(token, config.jwtSecret) as AuthUser;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

const rank = { VIEWER: 10, OPERATOR: 20, ADMIN: 30, OWNER: 40 };

export function requireRole(role: keyof typeof rank) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'authentication_required' });
    if (rank[req.user.role] < rank[role]) return res.status(403).json({ error: 'insufficient_role' });
    return next();
  };
}
