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
exports.compensationRouter = void 0;
exports.applyDuePayChanges = applyDuePayChanges;
/** P9 commission, P10 combined pay, P17 pay changes, P18 bonuses. Rules live in payCore.ts (unit tested). Money is stored in cents. */
const express_1 = require("express");
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const P = __importStar(require("./payCore"));
const services_1 = require("./services");
const http_1 = require("./http");
exports.compensationRouter = (0, express_1.Router)();
const R = exports.compensationRouter;
const PERIOD = /^\d{4}-\d{2}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const bounds = (p) => { const [y, m] = p.split('-').map(Number); return [`${p}-01`, `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`]; };
const money = (v, label, allowZero = false) => { const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0))
    throw (0, http_1.bad)(`${label} must be a valid amount`); return n; };
const str = (v, min, max, label) => { const t = String(v ?? '').trim(); if (t.length < min || t.length > max)
    throw (0, http_1.bad)(`${label} must be ${min} to ${max} characters`); return t; };
const getEmp = async (id) => { const e = await M.Employee.findByPk(Number(id) || 0); if (!e || e.status === 'terminated')
    throw (0, http_1.bad)('Employee not found', 404); return e; };
async function named(rows) {
    const ids = [...new Set(rows.map((x) => x.employeeId))];
    const emps = ids.length ? await M.Employee.findAll({ where: { id: { [sequelize_1.Op.in]: ids } }, attributes: ['id', 'name'], raw: true }) : [];
    const m = new Map(emps.map((e) => [e.id, e.name]));
    return rows.map((x) => ({ ...(x.toJSON ? x.toJSON() : x), employeeName: m.get(x.employeeId) || '' }));
}
const mine = async (q) => (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user));
/** Apply approved pay changes whose effective date has arrived. Called before payroll and when listing. */
async function applyDuePayChanges() {
    const due = await M.PayChange.findAll({ where: { status: 'approved', applied: false, effectiveDate: { [sequelize_1.Op.lte]: today() } } });
    for (const c of due) {
        const e = await M.Employee.findByPk(c.employeeId);
        if (!e)
            continue;
        await c.update({ applied: true, oldPay: { payType: e.payType, hourlyRate: e.hourlyRate, annualSalary: e.annualSalary, flsaExempt: e.flsaExempt } });
        await e.update({ payType: c.payType, hourlyRate: c.payType === 'hourly' ? c.hourlyCents / 100 : Math.round(c.annualCents / 2080) / 100, annualSalary: c.payType === 'salary' ? c.annualCents / 100 : 0, flsaExempt: c.flsaExempt });
        await (0, services_1.log)(0, 'Pay Change Applied', `employee #${e.id} effective ${c.effectiveDate}`);
    }
    return due.length;
}
// ---------------- P9 commission plans and sales ----------------
R.get('/commission/plans', (0, http_1.wrap)(async (q, s) => s.json(await named(await M.CommissionPlan.findAll({ where: await mine(q), order: [['id', 'DESC']], limit: 200 })))));
R.post('/commission/plans', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const b = q.body || {}, e = await getEmp(b.employeeId), kind = b.kind === 'tiered' ? 'tiered' : 'flat';
    const plan = kind === 'flat' ? { kind, rate: Number(b.rate) / 100 }
        : { kind, tiers: (Array.isArray(b.tiers) ? b.tiers : []).map((t) => ({ upTo: t.upTo === null || t.upTo === '' || t.upTo === undefined ? null : money(t.upTo, 'Tier limit'), rate: Number(t.rate) / 100 })) };
    if (b.cap !== undefined && b.cap !== null && b.cap !== '')
        plan.capCents = money(b.cap, 'Cap');
    const errs = P.validatePlan(plan);
    if (errs.length)
        throw (0, http_1.bad)(errs[0]);
    const draw = b.draw ? money(b.draw, 'Draw', true) : 0, name = str(b.name, 2, 80, 'Plan name');
    await M.CommissionPlan.update({ active: false }, { where: { employeeId: e.id, active: true } });
    const row = await M.CommissionPlan.create({ employeeId: e.id, name, kind, rate: plan.rate ?? null, tiers: plan.tiers ?? null, capCents: plan.capCents ?? null, drawCents: draw, active: true, createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'Commission Plan Assigned', `employee #${e.id} ${name}`);
    s.json(row);
}));
R.get('/sales', (0, http_1.wrap)(async (q, s) => s.json(await named(await M.Sale.findAll({ where: await mine(q), order: [['saleDate', 'DESC'], ['id', 'DESC']], limit: 300 })))));
R.post('/sales', (0, http_1.wrap)(async (q, s) => {
    const b = q.body || {}, empId = Number(b.employeeId) || q.user.id;
    await getEmp(empId);
    if (empId !== q.user.id && (await (0, services_1.approverCheck)(q.user, empId)) !== 'ok')
        return s.status(403).json({ error: 'Not allowed for this employee' });
    const plan = await M.CommissionPlan.findOne({ where: { employeeId: empId, active: true } });
    if (!plan)
        throw (0, http_1.bad)('This employee has no active commission plan');
    if (!DATE.test(String(b.saleDate || '')) || b.saleDate > today())
        throw (0, http_1.bad)('Sale date must be a valid date that is not in the future');
    const split = Number(b.splitPct ?? 100);
    if (!(split >= 1 && split <= 100))
        throw (0, http_1.bad)('Split must be between 1 and 100');
    if (await M.CommissionLine.findOne({ where: { employeeId: empId, period: b.saleDate.slice(0, 7), status: { [sequelize_1.Op.in]: ['approved', 'locked'] } } }))
        throw (0, http_1.bad)('Commission for that month is already approved. Ask HR to return it first.');
    const row = await M.Sale.create({ employeeId: empId, planId: plan.id, saleDate: b.saleDate, amountCents: money(b.amount, 'Sale amount'), splitPct: split, description: str(b.description, 2, 200, 'Description'), enteredBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'Sale Recorded', `#${row.id} employee #${empId}`);
    s.json(row);
}));
R.post('/sales/:id/refund', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const x = await M.Sale.findByPk(Number(q.params.id) || 0);
    if (!x)
        throw (0, http_1.bad)('Sale not found', 404);
    const refund = money(q.body?.refund, 'Refund');
    if (refund > x.amountCents)
        throw (0, http_1.bad)('Refund cannot be more than the sale');
    await x.update({ refundCents: refund, refundedAt: today(), clawbackPeriod: null });
    await (0, services_1.log)(q.user.id, 'Sale Refunded', `#${x.id} ${refund / 100}`);
    s.json({ ok: true });
}));
// ---------------- P9 calculate, review, approve ----------------
R.post('/commission/calculate', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const period = String(q.body?.period || '');
    if (!PERIOD.test(period))
        throw (0, http_1.bad)('period must look like 2026-11');
    const [from, to] = bounds(period);
    let made = 0, skipped = 0;
    for (const plan of (await M.CommissionPlan.findAll({ where: { active: true } }))) {
        const emp = await M.Employee.findByPk(plan.employeeId);
        if (!emp || emp.status === 'terminated')
            continue;
        const existing = await M.CommissionLine.findOne({ where: { employeeId: plan.employeeId, period } });
        if (existing && !['draft', 'returned'].includes(existing.status)) {
            skipped++;
            continue;
        }
        const sales = await M.Sale.findAll({ where: { employeeId: plan.employeeId, saleDate: { [sequelize_1.Op.between]: [from, to] } } });
        const credited = P.creditedSales(sales.map((x) => ({ amountCents: x.amountCents, splitPct: x.splitPct })));
        const earned = P.commissionFor(credited, { kind: plan.kind, rate: plan.rate == null ? undefined : Number(plan.rate), tiers: plan.tiers || undefined, capCents: plan.capCents });
        for (const x of sales)
            await x.update({ commissionPaidCents: credited ? Math.round(earned * Math.round(x.amountCents * x.splitPct / 100) / credited) : 0 });
        const prev = await M.CommissionLine.findOne({ where: { employeeId: plan.employeeId, period: { [sequelize_1.Op.lt]: period } }, order: [['period', 'DESC']] });
        const dr = P.applyDraw(earned, plan.drawCents || 0, prev?.shortfallCents || 0);
        const refunds = await M.Sale.findAll({ where: { employeeId: plan.employeeId, refundCents: { [sequelize_1.Op.gt]: 0 }, refundedAt: { [sequelize_1.Op.lte]: to }, [sequelize_1.Op.or]: [{ clawbackPeriod: null }, { clawbackPeriod: period }] } });
        let claw = 0;
        for (const x of refunds) {
            claw += P.clawbackLine(x.commissionPaidCents, x.amountCents, x.refundCents);
            await x.update({ clawbackPeriod: period });
        }
        const data = { employeeId: plan.employeeId, period, creditedCents: credited, earnedCents: earned, drawCents: dr.drawPaid, extraCents: dr.extraPaid, shortfallCents: dr.shortfallOut, clawbackCents: claw, payableCents: dr.drawPaid + dr.extraPaid + claw, status: 'draft', comment: null };
        if (existing)
            await existing.update(data);
        else
            await M.CommissionLine.create(data);
        made++;
    }
    await (0, services_1.log)(q.user.id, 'Commission Calculated', `${period} lines:${made} skipped:${skipped}`);
    s.json({ ok: true, lines: made, skipped });
}));
R.get('/commission/lines', (0, http_1.wrap)(async (q, s) => s.json(await named(await M.CommissionLine.findAll({ where: await mine(q), order: [['period', 'DESC'], ['id', 'DESC']], limit: 300 })))));
R.post('/commission/lines/:id/decide', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const l = await M.CommissionLine.findByPk(Number(q.params.id) || 0);
    if (!l)
        throw (0, http_1.bad)('Line not found', 404);
    const ok = await (0, services_1.approverCheck)(q.user, l.employeeId);
    if (ok === 'self')
        throw (0, http_1.bad)('You cannot approve your own commission', 403);
    if (ok === 'forbidden')
        throw (0, http_1.bad)('Not your team', 403);
    if (l.status !== 'draft')
        throw (0, http_1.bad)('This statement was already decided');
    const approve = q.body?.approve === true, comment = String(q.body?.comment || '').trim();
    if (!approve && comment.length < 3)
        throw (0, http_1.bad)('Add a comment when returning a statement');
    await l.update({ status: approve ? 'approved' : 'returned', comment: comment || null, decidedBy: q.user.id });
    await (0, services_1.log)(q.user.id, approve ? 'Commission Approved' : 'Commission Returned', `line #${l.id} ${l.period}`);
    s.json(l);
}));
// ---------------- P18 bonuses ----------------
R.get('/bonuses', (0, http_1.wrap)(async (q, s) => s.json(await named(await M.Bonus.findAll({ where: await mine(q), order: [['id', 'DESC']], limit: 300 })))));
R.post('/bonuses', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const b = q.body || {}, e = await getEmp(b.employeeId), chk = await (0, services_1.approverCheck)(q.user, e.id);
    if (chk === 'self')
        throw (0, http_1.bad)('You cannot propose a bonus for yourself', 403);
    if (chk === 'forbidden')
        throw (0, http_1.bad)('Not your team', 403);
    const kind = ['annual', 'spot', 'signing', 'retention', 'referral'].includes(b.kind) ? b.kind : null;
    if (!kind)
        throw (0, http_1.bad)('Choose a bonus type');
    if (!PERIOD.test(String(b.payPeriod || '')))
        throw (0, http_1.bad)('Pay period must look like 2026-12');
    const win = Number(b.windowMonths ?? 12);
    if (!Number.isInteger(win) || win < 0 || win > 60)
        throw (0, http_1.bad)('Clawback window must be 0 to 60 months');
    const row = await M.Bonus.create({ employeeId: e.id, kind, amountCents: money(b.amount, 'Bonus amount'), discretionary: b.discretionary !== false, reason: str(b.reason, 3, 300, 'Reason'), payPeriod: b.payPeriod, proposedBy: q.user.id, clawbackWindowMonths: win, agreementOnFile: b.agreementOnFile === true });
    await (0, services_1.log)(q.user.id, 'Bonus Proposed', `#${row.id} employee #${e.id}`);
    s.json(row);
}));
R.post('/bonuses/:id/decide', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const x = await M.Bonus.findByPk(Number(q.params.id) || 0);
    if (!x)
        throw (0, http_1.bad)('Bonus not found', 404);
    if (x.status !== 'proposed')
        throw (0, http_1.bad)('This bonus was already decided');
    if (x.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot approve your own bonus', 403);
    if (x.proposedBy === q.user.id)
        throw (0, http_1.bad)('Another person must approve this bonus', 403);
    const approve = q.body?.approve === true, comment = String(q.body?.comment || '').trim();
    if (!approve && comment.length < 3)
        throw (0, http_1.bad)('Add a comment when rejecting');
    let withholding = 0;
    if (approve) { // flat supplemental method, YTD of this employee's other approved or paid bonuses
        const others = await M.Bonus.findAll({ where: { employeeId: x.employeeId, id: { [sequelize_1.Op.ne]: x.id }, status: { [sequelize_1.Op.in]: ['approved', 'paid'] }, payPeriod: { [sequelize_1.Op.like]: `${String(x.payPeriod).slice(0, 4)}-%` } }, raw: true });
        withholding = P.supplementalWithholding(x.amountCents, others.reduce((a, o) => a + o.amountCents, 0));
    }
    await x.update({ status: approve ? 'approved' : 'rejected', decidedBy: q.user.id, comment: comment || null, withholdingCents: withholding });
    await (0, services_1.log)(q.user.id, approve ? 'Bonus Approved' : 'Bonus Rejected', `#${x.id}`);
    s.json(x);
}));
R.post('/bonuses/:id/clawback', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const x = await M.Bonus.findByPk(Number(q.params.id) || 0);
    if (!x)
        throw (0, http_1.bad)('Bonus not found', 404);
    if (x.status !== 'paid')
        throw (0, http_1.bad)('Only a paid bonus can be recovered');
    const months = Math.max(0, Math.floor((Date.now() - new Date(x.paidAt).getTime()) / (30.44 * 864e5)));
    const d = P.clawbackDecision({ agreementOnFile: !!x.agreementOnFile, monthsSincePaid: months, windowMonths: x.clawbackWindowMonths, stateRestrictsDeduction: q.body?.stateRestrictsDeduction === true });
    if (!d.allowed)
        throw (0, http_1.bad)(d.reason);
    await x.update({ status: 'clawed_back', clawbackMethod: d.method, comment: str(q.body?.reason, 3, 300, 'Reason') });
    await (0, services_1.log)(q.user.id, 'Bonus Clawback', `#${x.id} via ${d.method}`);
    s.json({ ok: true, method: d.method, note: d.reason });
}));
// ---------------- P17 pay changes ----------------
R.get('/pay-changes', (0, http_1.wrap)(async (q, s) => { await applyDuePayChanges(); s.json(await named(await M.PayChange.findAll({ where: await mine(q), order: [['id', 'DESC']], limit: 300 }))); }));
R.post('/pay-changes', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const b = q.body || {}, e = await getEmp(b.employeeId), chk = await (0, services_1.approverCheck)(q.user, e.id);
    if (chk === 'self')
        throw (0, http_1.bad)('You cannot propose your own pay change', 403);
    if (chk === 'forbidden')
        throw (0, http_1.bad)('Not your team', 403);
    const payType = b.payType === 'salary' ? 'salary' : 'hourly', exempt = b.flsaExempt === true;
    if (exempt && payType !== 'salary')
        throw (0, http_1.bad)('Exempt employees must be paid a salary');
    const hourlyCents = payType === 'hourly' ? money(b.hourlyRate, 'Hourly rate') : 0, annualCents = payType === 'salary' ? money(b.annualSalary, 'Annual salary') : hourlyCents * 2080;
    if (!DATE.test(String(b.effectiveDate || '')))
        throw (0, http_1.bad)('Effective date is required');
    const band = b.bandMin && b.bandMax ? { min: money(b.bandMin, 'Band minimum'), max: money(b.bandMax, 'Band maximum') } : undefined;
    const chkPay = P.checkPay({ exempt, annualCents, state: e.workState || 'US', band });
    if (!chkPay.ok)
        throw (0, http_1.bad)(chkPay.errors[0]);
    const row = await M.PayChange.create({ employeeId: e.id, proposedBy: q.user.id, payType, hourlyCents, annualCents, flsaExempt: exempt, effectiveDate: b.effectiveDate, reason: str(b.reason, 3, 300, 'Reason'), warnings: chkPay.warnings });
    await (0, services_1.log)(q.user.id, 'Pay Change Proposed', `#${row.id} employee #${e.id}`);
    s.json(row);
}));
R.post('/pay-changes/:id/decide', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.PayChange.findByPk(Number(q.params.id) || 0);
    if (!c)
        throw (0, http_1.bad)('Pay change not found', 404);
    if (c.status !== 'pending')
        throw (0, http_1.bad)('This pay change was already decided');
    if (c.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot approve your own pay change', 403);
    if (c.proposedBy === q.user.id)
        throw (0, http_1.bad)('Another person must approve this pay change', 403);
    const approve = q.body?.approve === true, comment = String(q.body?.comment || '').trim();
    if (approve && q.body?.budgetApproved !== true)
        throw (0, http_1.bad)('Confirm the budget is approved first');
    if (!approve && comment.length < 3)
        throw (0, http_1.bad)('Add a comment when rejecting');
    await c.update({ status: approve ? 'approved' : 'rejected', budgetApproved: approve, decidedBy: q.user.id, comment: comment || null });
    if (approve)
        await applyDuePayChanges();
    await (0, services_1.log)(q.user.id, approve ? 'Pay Change Approved' : 'Pay Change Rejected', `#${c.id}`);
    s.json(await M.PayChange.findByPk(c.id));
}));
void services_1.isHR;
