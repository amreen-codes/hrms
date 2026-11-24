/** Server-side sessions (httpOnly cookie, 15 min idle timeout, 8 h absolute) and security events. */
import crypto from 'node:crypto';
import * as M from './models';
import { als, runSystem } from './tenancy';
import { HttpErr } from './services';
import { isIdle } from './platformCore';

export const COOKIE = 'ams_sid';
export const idleMinutes = () => Number(process.env.SESSION_IDLE_MIN) || 15;
export const absoluteMs = () => (Number(process.env.SESSION_MAX_HOURS) || 8) * 3600_000;
export const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
/** Bearer tokens exist only for automated tests; the browser uses the cookie. Never in production. */
export const bearerAllowed = () => process.env.ALLOW_BEARER === 'true' && process.env.NODE_ENV !== 'production';
export const SAFE = ['GET', 'HEAD', 'OPTIONS'];

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of String(header || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
}
export function setSessionCookie(s: any, token: string) {
  s.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
}
export const clearSessionCookie = (s: any) => s.clearCookie(COOKIE, { path: '/' });

export async function createSession(emp: any, q: any) {
  const token = crypto.randomBytes(32).toString('base64url');
  await runSystem(() => M.Session.create({ employeeId: emp.id, companyId: emp.companyId ?? null, tokenHash: sha(token), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + absoluteMs()),
    ip: String(q.ip || '').slice(0, 64), userAgent: String(q.headers['user-agent'] || '').slice(0, 255) } as any));
  return token;
}
export const secEvent = (type: string, emp: any | null, detail: string, q?: any) => runSystem(() =>
  M.SecurityEvent.create({ type, employeeId: emp?.id ?? null, companyId: emp?.companyId ?? null, detail: detail.slice(0, 1000), ip: String(q?.ip || '').slice(0, 64) } as any)).catch(() => null);

export interface Authed { session: any; emp: any; user: { id: number; role: string; name: string; companyId: number | null; mustChangePassword: boolean } }
/** Validates the session on EVERY request: not revoked, not idle, not expired, employee still active, company still active. */
export function authenticate(q: any): Promise<Authed | null> {
  return als.run({ platform: true }, async () => {
    let token = readCookie(q.headers.cookie, COOKIE); const viaCookie = !!token;
    if (!token && bearerAllowed()) token = String(q.headers.authorization || '').replace(/^Bearer /, '') || undefined;
    if (!token) return null;
    const session: any = await M.Session.findOne({ where: { tokenHash: sha(token), revokedAt: null } });
    if (!session) return null;
    const now = Date.now();
    if (+session.expiresAt < now || isIdle(+session.lastSeenAt, now, idleMinutes())) { await session.update({ revokedAt: new Date() }); return null; }   // P14: 15 minute idle timeout
    const emp: any = await M.Employee.findByPk(session.employeeId, { attributes: ['id', 'role', 'name', 'status', 'email', 'accessRevokedAt', 'companyId', 'mustChangePassword'] });
    if (!emp || ['terminated', 'invited'].includes(emp.status) || (emp.accessRevokedAt && +new Date(emp.accessRevokedAt) <= now)) return null;
    if (emp.companyId) { const c: any = await M.Company.findByPk(emp.companyId); if (!c || c.status !== 'active') return null; }
    if (viaCookie && !SAFE.includes(q.method) && q.headers['x-requested-with'] !== 'ams') throw new HttpErr(403, 'CSRF check failed');   // cookie auth needs the custom header
    await session.update({ lastSeenAt: new Date() });
    return { session, emp, user: { id: emp.id, role: emp.role, name: emp.name, companyId: emp.companyId ?? null, mustChangePassword: !!emp.mustChangePassword } };
  });
}
