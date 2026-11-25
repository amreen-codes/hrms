"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = exports.PW_CHANGE_REQUIRED = exports.authRouter = void 0;
/** P14 login (email + password only), cookie sessions, invite acceptance, password change. */
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
const S = __importStar(require("./security"));
const http_1 = require("./http");
const services_1 = require("./services");
const accountCore_1 = require("./accountCore");
exports.authRouter = (0, express_1.Router)();
const MAX_FAILED = 5, LOCK_MIN = 15;
const Emp = () => M.Employee.unscoped(); // login code needs the password field hidden by the default scope
const inCo = (companyId, fn) => tenancy_1.als.run(companyId ? { companyId } : { platform: true }, fn);
let dummy = null;
const dummyHash = () => (dummy ??= bcryptjs_1.default.hashSync('not-a-real-password', 12));
const limiter = process.env.NODE_ENV === 'test' ? (_q, _s, n) => n() : (0, express_rate_limit_1.default)({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const wipe = (u) => ({ id: u.id, name: u.name, role: u.role, companyId: u.companyId ?? null });
/** Sent to the client when an Admin set the password (or reset it): every route except /auth/me, /auth/logout and /auth/change-password refuses the session until it is changed. */
exports.PW_CHANGE_REQUIRED = { error: 'You must change your password before continuing', mustChangePassword: true };
async function failAttempt(u, q) {
    const n = (u.failedAttempts || 0) + 1, lock = n >= MAX_FAILED;
    await (0, tenancy_1.runSystem)(() => Emp().update(lock ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MIN * 60_000) } : { failedAttempts: n }, { where: { id: u.id } }));
    await S.secEvent(lock ? 'account_locked' : 'login_failed', u, `attempt ${n}`, q);
    await inCo(u.companyId, () => (0, services_1.log)(u.id, lock ? 'Account Locked' : 'Login Failed', `attempt ${n}`));
}
exports.authRouter.post('/auth/login', limiter, (0, http_1.wrap)(async (q, s) => {
    const email = String(q.body.email || '').toLowerCase().trim(), pw = String(q.body.password || '');
    const u = await (0, tenancy_1.runSystem)(() => Emp().findOne({ where: { email } }));
    if (!u) {
        bcryptjs_1.default.compareSync(pw, dummyHash());
        await S.secEvent('login_unknown_user', null, email.slice(0, 120), q);
        return s.status(401).json({ error: 'Invalid email or password' });
    }
    if (u.lockedUntil && +new Date(u.lockedUntil) > Date.now())
        return s.status(423).json({ error: 'Account locked. Try again in 15 minutes.' });
    const co = u.companyId ? await (0, tenancy_1.runSystem)(() => M.Company.findByPk(u.companyId)) : null;
    const revoked = ['terminated', 'invited'].includes(u.status) || (u.accessRevokedAt && +new Date(u.accessRevokedAt) <= Date.now()) || (u.companyId && co?.status !== 'active');
    if (revoked || !u.password || !bcryptjs_1.default.compareSync(pw, u.password)) {
        if (!revoked)
            await failAttempt(u, q);
        return s.status(401).json({ error: 'Invalid email or password' });
    }
    await (0, tenancy_1.runSystem)(() => Emp().update({ failedAttempts: 0, lockedUntil: null }, { where: { id: u.id } }));
    const token = await S.createSession(u, q);
    S.setSessionCookie(s, token);
    await inCo(u.companyId, () => (0, services_1.log)(u.id, 'Login', ''));
    const body = { user: wipe(u), mustChangePassword: !!u.mustChangePassword };
    if (S.bearerAllowed())
        body.token = token;
    s.json(body);
}));
/** Any valid session, including one that must still change its password. Sets the company context for the handler. */
const sessionOnly = (q, s, n) => {
    S.authenticate(q).then((a) => {
        if (!a)
            return s.status(401).json({ error: 'Unauthorized' });
        q.user = a.user;
        q.session = a.session;
        q.emp = a.emp;
        tenancy_1.als.run(a.user.companyId ? { companyId: a.user.companyId } : { platform: true }, () => n());
    }).catch(n);
};
/** Fully signed-in company user (password already changed if an Admin set or reset it). */
const auth = (q, s, n) => {
    S.authenticate(q).then((a) => {
        if (!a)
            return s.status(401).json({ error: 'Unauthorized' });
        if (a.user.role === 'superadmin' || !a.user.companyId)
            return s.status(403).json({ error: 'Use the platform console' });
        if (a.user.mustChangePassword)
            return s.status(403).json(exports.PW_CHANGE_REQUIRED);
        q.user = a.user;
        q.session = a.session;
        tenancy_1.als.run({ companyId: a.user.companyId }, () => n());
    }).catch(n);
};
exports.auth = auth;
exports.authRouter.get('/auth/me', sessionOnly, (0, http_1.wrap)(async (q, s) => {
    const u = q.user, co = u.companyId ? await M.Company.findByPk(u.companyId) : null;
    s.json({ user: { id: u.id, name: u.name, role: u.role, companyId: u.companyId }, company: co ? { name: co.name, slug: co.slug, plan: co.plan, subState: co.subState } : null, mustChangePassword: !!u.mustChangePassword });
}));
exports.authRouter.post('/auth/logout', (0, http_1.wrap)(async (q, s) => {
    const a = await S.authenticate(q).catch(() => null);
    if (a)
        await (0, tenancy_1.runSystem)(() => a.session.update({ revokedAt: new Date() }));
    S.clearSessionCookie(s);
    s.json({ ok: true });
}));
// ---------------- invite + password ----------------
exports.authRouter.post('/auth/accept-invite', limiter, (0, http_1.wrap)(async (q, s) => {
    const token = String(q.body.token || ''), pw = String(q.body.password || '');
    const pwErr = (0, accountCore_1.passwordProblem)(pw);
    if (pwErr)
        throw (0, http_1.bad)(pwErr);
    const u = token ? await (0, tenancy_1.runSystem)(() => Emp().findOne({ where: { inviteTokenHash: S.sha(token), status: 'invited' } })) : null;
    if (!u || !u.inviteExpiresAt || +new Date(u.inviteExpiresAt) < Date.now())
        throw (0, http_1.bad)('This invitation is invalid or has expired', 400);
    await (0, tenancy_1.runSystem)(() => Emp().update({ password: bcryptjs_1.default.hashSync(pw, 12), status: 'active', mustChangePassword: false, inviteTokenHash: null, inviteExpiresAt: null, passwordChangedAt: new Date() }, { where: { id: u.id } }));
    await inCo(u.companyId, () => (0, services_1.log)(u.id, 'Invitation Accepted', ''));
    s.json({ ok: true });
}));
exports.authRouter.post('/auth/change-password', sessionOnly, limiter, (0, http_1.wrap)(async (q, s) => {
    const cur = String(q.body.current || ''), next = String(q.body.next || '');
    const u = await Emp().findByPk(q.user.id);
    const pwErr = (0, accountCore_1.passwordProblem)(next, u?.email);
    if (pwErr)
        throw (0, http_1.bad)(pwErr);
    if (q.body.confirm !== undefined && String(q.body.confirm) !== next)
        throw (0, http_1.bad)('The new passwords do not match');
    if (!u?.password || !bcryptjs_1.default.compareSync(cur, u.password)) {
        if (u)
            await failAttempt(u, q);
        throw (0, http_1.bad)('Current password is incorrect', 401);
    }
    if (cur === next)
        throw (0, http_1.bad)('Choose a password that is different from the current one');
    await Emp().update({ password: bcryptjs_1.default.hashSync(next, 12), passwordChangedAt: new Date(), mustChangePassword: false, failedAttempts: 0 }, { where: { id: u.id } });
    await (0, tenancy_1.runSystem)(() => M.Session.update({ revokedAt: new Date() }, { where: { employeeId: u.id, revokedAt: null, id: { [require('sequelize').Op.ne]: q.session.id } } })); // other devices are signed out
    await (0, services_1.log)(u.id, 'Password Changed', u.mustChangePassword ? 'first-login change' : '');
    s.json({ ok: true });
}));
