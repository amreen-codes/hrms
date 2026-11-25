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
exports.platformRouter = void 0;
/** Super Admin console (P14): create companies, assign plans, invite the first admin, suspend. Not reachable by company users. */
const express_1 = require("express");
const node_crypto_1 = __importDefault(require("node:crypto"));
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
const S = __importStar(require("./security"));
const http_1 = require("./http");
const platformCore_1 = require("./platformCore");
const auth_1 = require("./auth");
const mail_1 = require("./mail");
exports.platformRouter = (0, express_1.Router)();
exports.platformRouter.use('/platform', (q, s, n) => {
    S.authenticate(q).then((a) => {
        if (!a || a.user.role !== 'superadmin')
            return s.status(401).json({ error: 'Unauthorized' });
        if (a.user.mustChangePassword)
            return s.status(403).json(auth_1.PW_CHANGE_REQUIRED);
        q.user = a.user;
        tenancy_1.als.run({ platform: true }, () => n());
    }).catch(n);
});
const invite = async (adminId) => {
    const token = node_crypto_1.default.randomBytes(32).toString('base64url');
    await M.Employee.unscoped().update({ inviteTokenHash: S.sha(token), inviteExpiresAt: new Date(Date.now() + 72 * 3600_000) }, { where: { id: adminId } });
    const base = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0];
    const inviteUrl = `${base}/accept-invite?token=${token}`;
    const a = await M.Employee.unscoped().findByPk(adminId, { attributes: ['name', 'email', 'companyId'] }), co = a?.companyId ? await M.Company.findByPk(a.companyId) : null;
    const emailed = a ? (await (0, mail_1.sendMail)({ to: a.email, kind: 'invite', companyId: a.companyId, subject: `You are invited to ${co?.name || 'AMS HRMS'}`, text: (0, mail_1.inviteText)(a.name, co?.name || 'your company', inviteUrl, 72) })) === 'sent' : false;
    return { inviteToken: token, inviteUrl, expiresInHours: 72, emailed }; // link is also returned once so the Super Admin can send it by hand when SMTP is not configured
};
exports.platformRouter.get('/platform/companies', (0, http_1.wrap)(async (_q, s) => {
    const cs = await M.Company.findAll({ order: [['id', 'DESC']], raw: true });
    const counts = await M.Employee.findAll({ attributes: ['companyId', [M.sequelize.fn('COUNT', M.sequelize.col('id')), 'n']], group: ['companyId'], raw: true });
    s.json(cs.map((c) => ({ ...c, employees: Number(counts.find((x) => x.companyId === c.id)?.n || 0) })));
}));
exports.platformRouter.post('/platform/companies', (0, http_1.wrap)(async (q, s) => {
    const b = q.body, name = String(b.name || '').trim(), slug = String(b.slug || '').trim().toLowerCase(), email = String(b.adminEmail || '').trim().toLowerCase(), adminName = String(b.adminName || '').trim();
    const plan = String(b.plan || 'starter');
    if (name.length < 2 || name.length > 160)
        throw (0, http_1.bad)('Company name is required');
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug))
        throw (0, http_1.bad)('Slug must be 3-40 characters: letters, numbers and dashes');
    if (!(plan in platformCore_1.PLANS))
        throw (0, http_1.bad)('Unknown plan');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !adminName)
        throw (0, http_1.bad)('Admin name and a valid email are required');
    if (await M.Company.findOne({ where: { slug } }))
        throw (0, http_1.bad)('That slug is taken', 409);
    if (await M.Employee.unscoped().findOne({ where: { email } }))
        throw (0, http_1.bad)('That email is already in use', 409);
    const co = await M.Company.create({ name, slug, plan, subState: 'trial' });
    const admin = await M.Employee.create({ name: adminName, email, role: 'admin', status: 'invited', companyId: co.id, password: node_crypto_1.default.randomBytes(24).toString('hex') /* unusable until the invite is accepted */ });
    await M.AuditLog.create({ actorId: q.user.id, action: 'Company Created', detail: `${name} (${slug}) plan ${plan}`, companyId: co.id });
    s.status(201).json({ company: co, admin: { id: admin.id, email }, ...(await invite(admin.id)) });
}));
exports.platformRouter.patch('/platform/companies/:id', (0, http_1.wrap)(async (q, s) => {
    const co = await M.Company.findByPk(q.params.id);
    if (!co)
        throw (0, http_1.bad)('Not found', 404);
    const up = {};
    if (q.body.status !== undefined) {
        if (!['active', 'suspended'].includes(q.body.status))
            throw (0, http_1.bad)('Unknown status');
        up.status = q.body.status;
    }
    if (q.body.plan !== undefined) {
        if (!(q.body.plan in platformCore_1.PLANS))
            throw (0, http_1.bad)('Unknown plan');
        up.plan = q.body.plan;
    }
    if (q.body.subState !== undefined) {
        if (!['trial', 'active', 'past_due', 'read_only', 'cancel_pending', 'cancelled'].includes(q.body.subState))
            throw (0, http_1.bad)('Unknown subscription state');
        up.subState = q.body.subState;
    }
    await co.update(up);
    if (up.status === 'suspended')
        await M.Session.update({ revokedAt: new Date() }, { where: { companyId: co.id, revokedAt: null } });
    await M.AuditLog.create({ actorId: q.user.id, action: 'Company Updated', detail: `${co.slug} ${JSON.stringify(up)}`, companyId: co.id });
    s.json(co);
}));
exports.platformRouter.post('/platform/companies/:id/reinvite', (0, http_1.wrap)(async (q, s) => {
    const admin = await M.Employee.unscoped().findOne({ where: { companyId: Number(q.params.id), role: 'admin', status: 'invited' } });
    if (!admin)
        throw (0, http_1.bad)('No pending admin invitation for this company', 404);
    s.json(await invite(admin.id));
}));
