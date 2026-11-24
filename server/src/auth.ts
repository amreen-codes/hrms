/** P14 login (email + password only), cookie sessions, invite acceptance, password change. */
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import * as M from './models';
import { als, runSystem } from './tenancy';
import * as S from './security';
import { wrap, bad } from './http';
import { log } from './services';
import { passwordProblem, MIN_PW } from './accountCore';

export const authRouter = Router();
const MAX_FAILED = 5, LOCK_MIN = 15;
const Emp = () => M.Employee.unscoped();                       // login code needs the password field hidden by the default scope
const inCo = <T>(companyId: number | null | undefined, fn: () => Promise<T>) => als.run(companyId ? { companyId } : { platform: true }, fn);
let dummy: string | null = null;
const dummyHash = () => (dummy ??= bcrypt.hashSync('not-a-real-password', 12));
const limiter = process.env.NODE_ENV === 'test' ? (_q: any, _s: any, n: any) => n() : rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const wipe = (u: any) => ({ id: u.id, name: u.name, role: u.role, companyId: u.companyId ?? null });
/** Sent to the client when an Admin set the password (or reset it): every route except /auth/me, /auth/logout and /auth/change-password refuses the session until it is changed. */
export const PW_CHANGE_REQUIRED = { error: 'You must change your password before continuing', mustChangePassword: true };

async function failAttempt(u: any, q: any) {
  const n = (u.failedAttempts || 0) + 1, lock = n >= MAX_FAILED;
  await runSystem(() => Emp().update(lock ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MIN * 60_000) } : { failedAttempts: n }, { where: { id: u.id } }));
  await S.secEvent(lock ? 'account_locked' : 'login_failed', u, `attempt ${n}`, q);
  await inCo(u.companyId, () => log(u.id, lock ? 'Account Locked' : 'Login Failed', `attempt ${n}`));
}

authRouter.post('/auth/login', limiter, wrap(async (q, s) => {
  const email = String(q.body.email || '').toLowerCase().trim(), pw = String(q.body.password || '');
  const u: any = await runSystem(() => Emp().findOne({ where: { email } }));
  if (!u) { bcrypt.compareSync(pw, dummyHash()); await S.secEvent('login_unknown_user', null, email.slice(0, 120), q); return s.status(401).json({ error: 'Invalid email or password' }); }
  if (u.lockedUntil && +new Date(u.lockedUntil) > Date.now()) return s.status(423).json({ error: 'Account locked. Try again in 15 minutes.' });
  const co: any = u.companyId ? await runSystem(() => M.Company.findByPk(u.companyId)) : null;
  const revoked = ['terminated', 'invited'].includes(u.status) || (u.accessRevokedAt && +new Date(u.accessRevokedAt) <= Date.now()) || (u.companyId && co?.status !== 'active');
  if (revoked || !u.password || !bcrypt.compareSync(pw, u.password)) { if (!revoked) await failAttempt(u, q); return s.status(401).json({ error: 'Invalid email or password' }); }
  await runSystem(() => Emp().update({ failedAttempts: 0, lockedUntil: null }, { where: { id: u.id } }));
  const token = await S.createSession(u, q);
  S.setSessionCookie(s, token);
  await inCo(u.companyId, () => log(u.id, 'Login', ''));
  const body: any = { user: wipe(u), mustChangePassword: !!u.mustChangePassword };
  if (S.bearerAllowed()) body.token = token;
  s.json(body);
}));

/** Any valid session, including one that must still change its password. Sets the company context for the handler. */
const sessionOnly = (q: any, s: Response, n: NextFunction) => {
  S.authenticate(q).then((a) => {
    if (!a) return s.status(401).json({ error: 'Unauthorized' });
    q.user = a.user; q.session = a.session; q.emp = a.emp;
    als.run(a.user.companyId ? { companyId: a.user.companyId } : { platform: true }, () => n());
  }).catch(n);
};
/** Fully signed-in company user (password already changed if an Admin set or reset it). */
export const auth = (q: any, s: Response, n: NextFunction) => {
  S.authenticate(q).then((a) => {
    if (!a) return s.status(401).json({ error: 'Unauthorized' });
    if (a.user.role === 'superadmin' || !a.user.companyId) return s.status(403).json({ error: 'Use the platform console' });
    if (a.user.mustChangePassword) return s.status(403).json(PW_CHANGE_REQUIRED);
    q.user = a.user; q.session = a.session;
    als.run({ companyId: a.user.companyId }, () => n());
  }).catch(n);
};

authRouter.get('/auth/me', sessionOnly, wrap(async (q, s) => {
  const u = q.user, co: any = u.companyId ? await M.Company.findByPk(u.companyId) : null;
  s.json({ user: { id: u.id, name: u.name, role: u.role, companyId: u.companyId }, company: co ? { name: co.name, slug: co.slug, plan: co.plan, subState: co.subState } : null, mustChangePassword: !!u.mustChangePassword });
}));
authRouter.post('/auth/logout', wrap(async (q, s) => {
  const a = await S.authenticate(q).catch(() => null);
  if (a) await runSystem(() => a.session.update({ revokedAt: new Date() }));
  S.clearSessionCookie(s); s.json({ ok: true });
}));

// ---------------- invite + password ----------------
authRouter.post('/auth/accept-invite', limiter, wrap(async (q, s) => {
  const token = String(q.body.token || ''), pw = String(q.body.password || '');
  const pwErr = passwordProblem(pw); if (pwErr) throw bad(pwErr);
  const u: any = token ? await runSystem(() => Emp().findOne({ where: { inviteTokenHash: S.sha(token), status: 'invited' } })) : null;
  if (!u || !u.inviteExpiresAt || +new Date(u.inviteExpiresAt) < Date.now()) throw bad('This invitation is invalid or has expired', 400);
  await runSystem(() => Emp().update({ password: bcrypt.hashSync(pw, 12), status: 'active', mustChangePassword: false, inviteTokenHash: null, inviteExpiresAt: null, passwordChangedAt: new Date() }, { where: { id: u.id } }));
  await inCo(u.companyId, () => log(u.id, 'Invitation Accepted', '')); s.json({ ok: true });
}));
authRouter.post('/auth/change-password', sessionOnly, limiter, wrap(async (q, s) => {
  const cur = String(q.body.current || ''), next = String(q.body.next || '');
  const u: any = await Emp().findByPk(q.user.id);
  const pwErr = passwordProblem(next, u?.email); if (pwErr) throw bad(pwErr);
  if (q.body.confirm !== undefined && String(q.body.confirm) !== next) throw bad('The new passwords do not match');
  if (!u?.password || !bcrypt.compareSync(cur, u.password)) { if (u) await failAttempt(u, q); throw bad('Current password is incorrect', 401); }
  if (cur === next) throw bad('Choose a password that is different from the current one');
  await Emp().update({ password: bcrypt.hashSync(next, 12), passwordChangedAt: new Date(), mustChangePassword: false, failedAttempts: 0 }, { where: { id: u.id } });
  await runSystem(() => M.Session.update({ revokedAt: new Date() }, { where: { employeeId: u.id, revokedAt: null, id: { [require('sequelize').Op.ne]: q.session.id } } }));   // other devices are signed out
  await log(u.id, 'Password Changed', u.mustChangePassword ? 'first-login change' : ''); s.json({ ok: true });
}));
