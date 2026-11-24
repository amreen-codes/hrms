import { Response, NextFunction } from 'express';
import { HttpErr } from './services';
/** Shared route helpers (used by routes.ts and lifecycle.ts). */
export const wrap = (f: (q: any, s: Response) => any) => (q: any, s: Response, n: NextFunction) => Promise.resolve(f(q, s)).catch(n);
export const bad = (m: string, status = 400) => new HttpErr(status, m);
export const only = (...roles: string[]) => (q: any, s: Response, n: NextFunction) => (roles.includes(q.user.role) ? n() : s.status(403).json({ error: 'Not allowed for your role' }));
export const staff = only('admin', 'hr', 'manager');
export const hr = only('admin', 'hr');
