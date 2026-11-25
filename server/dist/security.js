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
exports.secEvent = exports.clearSessionCookie = exports.SAFE = exports.bearerAllowed = exports.sha = exports.absoluteMs = exports.idleMinutes = exports.COOKIE = void 0;
exports.readCookie = readCookie;
exports.setSessionCookie = setSessionCookie;
exports.createSession = createSession;
exports.authenticate = authenticate;
/** Server-side sessions (httpOnly cookie, 15 min idle timeout, 8 h absolute) and security events. */
const node_crypto_1 = __importDefault(require("node:crypto"));
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
const services_1 = require("./services");
const platformCore_1 = require("./platformCore");
exports.COOKIE = 'ams_sid';
const idleMinutes = () => Number(process.env.SESSION_IDLE_MIN) || 15;
exports.idleMinutes = idleMinutes;
const absoluteMs = () => (Number(process.env.SESSION_MAX_HOURS) || 8) * 3600_000;
exports.absoluteMs = absoluteMs;
const sha = (v) => node_crypto_1.default.createHash('sha256').update(v).digest('hex');
exports.sha = sha;
/** Bearer tokens exist only for automated tests; the browser uses the cookie. Never in production. */
const bearerAllowed = () => process.env.ALLOW_BEARER === 'true' && process.env.NODE_ENV !== 'production';
exports.bearerAllowed = bearerAllowed;
exports.SAFE = ['GET', 'HEAD', 'OPTIONS'];
function readCookie(header, name) {
    for (const part of String(header || '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name)
            return decodeURIComponent(v.join('='));
    }
}
function setSessionCookie(s, token) {
    s.cookie(exports.COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
}
const clearSessionCookie = (s) => s.clearCookie(exports.COOKIE, { path: '/' });
exports.clearSessionCookie = clearSessionCookie;
async function createSession(emp, q) {
    const token = node_crypto_1.default.randomBytes(32).toString('base64url');
    await (0, tenancy_1.runSystem)(() => M.Session.create({ employeeId: emp.id, companyId: emp.companyId ?? null, tokenHash: (0, exports.sha)(token), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + (0, exports.absoluteMs)()),
        ip: String(q.ip || '').slice(0, 64), userAgent: String(q.headers['user-agent'] || '').slice(0, 255) }));
    return token;
}
const secEvent = (type, emp, detail, q) => (0, tenancy_1.runSystem)(() => M.SecurityEvent.create({ type, employeeId: emp?.id ?? null, companyId: emp?.companyId ?? null, detail: detail.slice(0, 1000), ip: String(q?.ip || '').slice(0, 64) })).catch(() => null);
exports.secEvent = secEvent;
/** Validates the session on EVERY request: not revoked, not idle, not expired, employee still active, company still active. */
function authenticate(q) {
    return tenancy_1.als.run({ platform: true }, async () => {
        let token = readCookie(q.headers.cookie, exports.COOKIE);
        const viaCookie = !!token;
        if (!token && (0, exports.bearerAllowed)())
            token = String(q.headers.authorization || '').replace(/^Bearer /, '') || undefined;
        if (!token)
            return null;
        const session = await M.Session.findOne({ where: { tokenHash: (0, exports.sha)(token), revokedAt: null } });
        if (!session)
            return null;
        const now = Date.now();
        if (+session.expiresAt < now || (0, platformCore_1.isIdle)(+session.lastSeenAt, now, (0, exports.idleMinutes)())) {
            await session.update({ revokedAt: new Date() });
            return null;
        } // P14: 15 minute idle timeout
        const emp = await M.Employee.findByPk(session.employeeId, { attributes: ['id', 'role', 'name', 'status', 'email', 'accessRevokedAt', 'companyId', 'mustChangePassword'] });
        if (!emp || ['terminated', 'invited'].includes(emp.status) || (emp.accessRevokedAt && +new Date(emp.accessRevokedAt) <= now))
            return null;
        if (emp.companyId) {
            const c = await M.Company.findByPk(emp.companyId);
            if (!c || c.status !== 'active')
                return null;
        }
        if (viaCookie && !exports.SAFE.includes(q.method) && q.headers['x-requested-with'] !== 'ams')
            throw new services_1.HttpErr(403, 'CSRF check failed'); // cookie auth needs the custom header
        await session.update({ lastSeenAt: new Date() });
        return { session, emp, user: { id: emp.id, role: emp.role, name: emp.name, companyId: emp.companyId ?? null, mustChangePassword: !!emp.mustChangePassword } };
    });
}
