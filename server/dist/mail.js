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
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteText = exports.flushMail = exports.setMailTransport = exports.mailConfigured = exports.appBase = void 0;
exports.sendMail = sendMail;
exports.queueMail = queueMail;
exports.installNotificationMailer = installNotificationMailer;
/** Outgoing e-mail: invitations, account notices and notification alerts. Every attempt is logged in EmailLog (never the message body or any password). */
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
const mailer_1 = require("./mailer");
const appBase = () => (process.env.APP_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
exports.appBase = appBase;
const mailConfigured = () => !!(0, mailer_1.cfgFromEnv)();
exports.mailConfigured = mailConfigured;
let transport = mailer_1.sendSmtp;
/** Tests only: replace the SMTP transport. */
const setMailTransport = (t) => { transport = t || mailer_1.sendSmtp; };
exports.setMailTransport = setMailTransport;
const pending = new Set();
async function sendMail(a) {
    const cfg = (0, mailer_1.cfgFromEnv)();
    let status = 'skipped', error = null;
    if (cfg) {
        try {
            await transport(cfg, { to: a.to, subject: a.subject, text: a.text });
            status = 'sent';
        }
        catch (e) {
            status = 'failed';
            error = String(e?.message || e).slice(0, 500);
            console.error('SMTP ERROR:', error);
        }
    }
    await (0, tenancy_1.runSystem)(() => M.EmailLog.create({ kind: a.kind, toEmail: a.to.slice(0, 160), subject: a.subject.slice(0, 300), status, error, companyId: a.companyId ?? null })).catch(() => null);
    return status;
}
/** Fire and forget: a slow or broken mail server must never slow down or fail a request. */
function queueMail(a) { const p = sendMail(a).catch(() => 'failed').finally(() => pending.delete(p)); pending.add(p); return p; }
const flushMail = () => Promise.all([...pending]);
exports.flushMail = flushMail;
const inviteText = (name, company, url, hours) => `Hello ${name},\n\nYou have been invited to ${company} on AMS HRMS as its administrator.\n\nChoose your password here (the link works once and expires in ${hours} hours):\n${url}\n\nIf you did not expect this message, ignore it.\n`;
exports.inviteText = inviteText;
let installed = false;
/** Optional e-mail alert for in-app notifications (NOTIFY_EMAIL=true). Only the title is sent, never the body: notifications can contain HR-sensitive detail. */
function installNotificationMailer() {
    if (installed)
        return;
    installed = true;
    const handle = async (rows) => {
        if (process.env.NOTIFY_EMAIL !== 'true' || !(0, mailer_1.cfgFromEnv)())
            return;
        for (const n of rows) {
            const e = await (0, tenancy_1.runSystem)(() => M.Employee.unscoped().findByPk(n.userId, { attributes: ['id', 'email', 'name', 'status', 'companyId'] }));
            if (!e?.email || ['terminated', 'invited'].includes(e.status))
                continue;
            queueMail({ to: e.email, kind: 'notification', companyId: e.companyId, subject: `AMS HRMS: ${String(n.title || 'New notification').slice(0, 150)}`,
                text: `Hello ${e.name},\n\nYou have a new notification in AMS HRMS: ${String(n.title || '').slice(0, 200)}\n\nSign in to read it: ${(0, exports.appBase)()}\n` });
        }
    };
    M.Notification.addHook('afterCreate', (n) => { handle([n]).catch(() => null); });
    M.Notification.addHook('afterBulkCreate', (ns) => { handle(ns).catch(() => null); });
}
