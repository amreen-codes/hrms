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
exports.record = exports.payrollFlowRouter = void 0;
/** BPMN P4 completed: Finance reviews and may adjust WITH A REASON, the Company Admin approves payroll, then lock and export. An admin can unlock with a reason (new version) until it is exported. Four-eyes: the approver is not the person who reviewed or adjusted. */
const express_1 = require("express");
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
exports.payrollFlowRouter = (0, express_1.Router)();
const round = (n) => Math.round(n * 100) / 100;
const period = (v) => { const p = String(v || ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p))
    throw (0, http_1.bad)('period must look like 2026-11'); return p; };
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const strict = () => process.env.PAYROLL_SINGLE_APPROVER !== 'true'; // set true only for one-person companies
const ping = (userId, title, body) => userId ? M.Notification.create({ userId, kind: 'payroll', title, body, entityType: 'payroll', entityId: 0 }).catch(() => null) : null;
const admins = async () => (await M.Employee.findAll({ where: { role: 'admin', status: { [sequelize_1.Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })).map((x) => x.id);
/** Finance "adjust with reason": a signed amount on one pay sheet. Sends the sheet back to draft so it must be reviewed again. */
exports.payrollFlowRouter.post('/payroll/sheets/:id/adjust', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const sh = await M.PaySheet.findByPk(Number(q.params.id));
    if (!sh)
        throw (0, http_1.bad)('Not found', 404);
    if (!['draft', 'reviewed'].includes(sh.status))
        throw (0, http_1.bad)(`A ${sh.status} pay sheet cannot be adjusted. Ask the Company Admin to unlock it first`, 409);
    const amount = Number(q.body.amount), reason = txt(q.body.reason, 1000);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000)
        throw (0, http_1.bad)('Enter a non-zero adjustment amount (up to $100,000)');
    if (reason.length < 10)
        throw (0, http_1.bad)('A reason is required (at least 10 characters)');
    if (sh.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot adjust your own pay sheet', 403);
    const tax = 'Tax withholding is not recalculated: check it on the provider side';
    await M.PayAdjustment.create({ sheetId: sh.id, employeeId: sh.employeeId, period: sh.period, version: sh.version, amount, reason, adjustedBy: q.user.id });
    await sh.update({ adjustment: round(Number(sh.adjustment) + amount), gross: round(Number(sh.gross) + amount), net: round(Number(sh.net) + amount), status: 'draft', reviewedBy: null, lastAdjustedBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'Pay Sheet Adjusted', `#${sh.id} ${sh.period} v${sh.version} ${amount > 0 ? '+' : ''}${amount}: ${reason.slice(0, 150)}`);
    s.json({ ...sh.toJSON(), note: tax });
}));
exports.payrollFlowRouter.get('/payroll/sheets/:id/adjustments', http_1.hr, (0, http_1.wrap)(async (q, s) => s.json(await M.PayAdjustment.findAll({ where: { sheetId: Number(q.params.id) }, order: [['id', 'ASC']] }))));
/** Finance confirms the sheets are correct. */
exports.payrollFlowRouter.post('/payroll/review', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const p = period(q.body.period);
    const rows = await M.PaySheet.findAll({ where: { period: p, status: 'draft' } });
    if (!rows.length)
        throw (0, http_1.bad)('There are no draft pay sheets to review for this period', 409);
    if (rows.some((r) => r.employeeId === q.user.id))
        throw (0, http_1.bad)('Your own pay sheet must be reviewed by someone else', 403);
    await M.PaySheet.update({ status: 'reviewed', reviewedBy: q.user.id }, { where: { period: p, status: 'draft' } });
    for (const a of await admins())
        await ping(a, 'Payroll ready for approval', `${p}: ${rows.length} pay sheet(s) reviewed`);
    await (0, services_1.log)(q.user.id, 'Payroll Reviewed', `${p} sheets:${rows.length}`);
    s.json({ ok: true, sheets: rows.length });
}));
/** "Approve payroll?" is the Company Admin's decision. */
exports.payrollFlowRouter.post('/payroll/approve', (0, http_1.only)('admin'), (0, http_1.wrap)(async (q, s) => {
    const p = period(q.body.period);
    const rows = await M.PaySheet.findAll({ where: { period: p, status: { [sequelize_1.Op.in]: ['draft', 'reviewed'] } } });
    if (!rows.length)
        throw (0, http_1.bad)('There is nothing waiting for approval for this period', 409);
    if (rows.some((r) => r.status === 'draft'))
        throw (0, http_1.bad)(`${rows.filter((r) => r.status === 'draft').length} pay sheet(s) are still drafts: Finance must review them first`, 409);
    if (rows.some((r) => r.employeeId === q.user.id))
        throw (0, http_1.bad)('Your own pay sheet must be approved by another admin', 403);
    if (strict() && rows.some((r) => r.reviewedBy === q.user.id || r.lastAdjustedBy === q.user.id))
        throw (0, http_1.bad)('Four-eyes control: the approver cannot be the person who reviewed or adjusted these sheets', 403);
    await M.PaySheet.update({ status: 'approved', approvedBy: q.user.id, approvedAt: new Date() }, { where: { period: p, status: 'reviewed' } });
    await (0, services_1.log)(q.user.id, 'Payroll Approved', `${p} sheets:${rows.length}`);
    s.json({ ok: true, sheets: rows.length });
}));
/** Not approved: back to Finance with the reason. */
exports.payrollFlowRouter.post('/payroll/reject', (0, http_1.only)('admin'), (0, http_1.wrap)(async (q, s) => {
    const p = period(q.body.period), reason = txt(q.body.reason, 1000);
    if (reason.length < 10)
        throw (0, http_1.bad)('Explain what Finance must fix (at least 10 characters)');
    const rows = await M.PaySheet.findAll({ where: { period: p, status: 'reviewed' } });
    if (!rows.length)
        throw (0, http_1.bad)('No reviewed pay sheets to send back', 409);
    await M.PaySheet.update({ status: 'draft', reviewedBy: null }, { where: { period: p, status: 'reviewed' } });
    for (const r of new Set(rows.map((x) => x.reviewedBy).filter(Boolean)))
        await ping(r, 'Payroll sent back', `${p}: ${reason}`);
    await (0, services_1.log)(q.user.id, 'Payroll Sent Back', `${p}: ${reason.slice(0, 200)}`);
    s.json({ ok: true, sheets: rows.length });
}));
/** Unlock with a reason: a NEW version; allowed until the file has been exported. */
exports.payrollFlowRouter.post('/payroll/unlock', (0, http_1.only)('admin'), (0, http_1.wrap)(async (q, s) => {
    const p = period(q.body.period), reason = txt(q.body.reason, 1000);
    if (reason.length < 10)
        throw (0, http_1.bad)('A reason is required (at least 10 characters)');
    if (await M.PaySheet.count({ where: { period: p, status: 'exported' } }))
        throw (0, http_1.bad)('This payroll was already exported to the provider. Correct it in the next pay period instead (P13)', 409);
    const rows = await M.PaySheet.findAll({ where: { period: p, status: 'locked' } });
    if (!rows.length)
        throw (0, http_1.bad)('There are no locked pay sheets for this period', 409);
    const ids = rows.map((r) => r.employeeId), who = { [sequelize_1.Op.in]: ids };
    for (const r of rows) {
        await M.PayrollVersion.create({ sheetId: r.id, employeeId: r.employeeId, period: p, version: r.version, gross: r.gross, net: r.net, lockedAt: r.updatedAt, unlockedBy: q.user.id, unlockReason: reason });
        await r.update({ status: 'draft', version: r.version + 1, reviewedBy: null, approvedBy: null, approvedAt: null });
    }
    const [y, m] = p.split('-').map(Number), first = `${p}-01`, last = `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    await M.Timesheet.update({ payrollStatus: 'ready' }, { where: { employeeId: who, payrollStatus: 'locked', periodStart: { [sequelize_1.Op.between]: [first, last] } } });
    await M.CommissionLine.update({ status: 'approved' }, { where: { employeeId: who, period: p, status: 'locked' } });
    await M.Bonus.update({ status: 'approved', paidAt: null }, { where: { employeeId: who, payPeriod: p, status: 'paid' } });
    for (const a of await admins())
        await ping(a, 'Payroll unlocked', `${p}: ${reason}`);
    await (0, services_1.log)(q.user.id, 'Payroll Unlocked', `${p} new version, sheets:${rows.length}: ${reason.slice(0, 200)}`);
    s.json({ ok: true, sheets: rows.length, newVersion: rows[0].version });
}));
exports.payrollFlowRouter.get('/payroll/history', http_1.hr, (0, http_1.wrap)(async (q, s) => s.json({ versions: await M.PayrollVersion.findAll({ where: q.query.period ? { period: String(q.query.period) } : {}, order: [['id', 'DESC']], limit: 300 }), exports: await M.PayrollExport.findAll({ order: [['id', 'DESC']], limit: 100 }) })));
const record = async (periodStr, rows, hash, by, versionMax) => M.PayrollExport.create({ period: periodStr, rows, fileHash: hash, exportedBy: by, versionMax });
exports.record = record;
