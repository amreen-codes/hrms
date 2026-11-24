/** P9 commission, P10 combined pay, P17 pay changes, P18 bonuses. Rules live in payCore.ts (unit tested). Money is stored in cents. */
import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import * as P from './payCore';
import { log, scopeIds, inScope, approverCheck, isHR } from './services';
import { wrap, bad, staff, hr } from './http';

export const compensationRouter = Router();
const R = compensationRouter;
const PERIOD = /^\d{4}-\d{2}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const bounds = (p: string): [string, string] => { const [y, m] = p.split('-').map(Number); return [`${p}-01`, `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`]; };
const money = (v: any, label: string, allowZero = false) => { const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw bad(`${label} must be a valid amount`); return n; };
const str = (v: any, min: number, max: number, label: string) => { const t = String(v ?? '').trim(); if (t.length < min || t.length > max) throw bad(`${label} must be ${min} to ${max} characters`); return t; };
const getEmp = async (id: any) => { const e: any = await M.Employee.findByPk(Number(id) || 0); if (!e || e.status === 'terminated') throw bad('Employee not found', 404); return e; };
async function named(rows: any[]) {
  const ids = [...new Set(rows.map((x) => x.employeeId))]; const emps: any[] = ids.length ? await M.Employee.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'name'], raw: true }) : [];
  const m = new Map(emps.map((e) => [e.id, e.name])); return rows.map((x) => ({ ...(x.toJSON ? x.toJSON() : x), employeeName: m.get(x.employeeId) || '' }));
}
const mine = async (q: any) => inScope(await scopeIds(q.user)) as any;

/** Apply approved pay changes whose effective date has arrived. Called before payroll and when listing. */
export async function applyDuePayChanges() {
  const due: any[] = await M.PayChange.findAll({ where: { status: 'approved', applied: false, effectiveDate: { [Op.lte]: today() } } });
  for (const c of due) {
    const e: any = await M.Employee.findByPk(c.employeeId); if (!e) continue;
    await c.update({ applied: true, oldPay: { payType: e.payType, hourlyRate: e.hourlyRate, annualSalary: e.annualSalary, flsaExempt: e.flsaExempt } });
    await e.update({ payType: c.payType, hourlyRate: c.payType === 'hourly' ? c.hourlyCents / 100 : Math.round(c.annualCents / 2080) / 100, annualSalary: c.payType === 'salary' ? c.annualCents / 100 : 0, flsaExempt: c.flsaExempt });
    await log(0, 'Pay Change Applied', `employee #${e.id} effective ${c.effectiveDate}`);
  }
  return due.length;
}

// ---------------- P9 commission plans and sales ----------------
R.get('/commission/plans', wrap(async (q, s) => s.json(await named(await M.CommissionPlan.findAll({ where: await mine(q), order: [['id', 'DESC']], limit: 200 })))));
R.post('/commission/plans', hr, wrap(async (q, s) => {
  const b = q.body || {}, e = await getEmp(b.employeeId), kind = b.kind === 'tiered' ? 'tiered' : 'flat';
  const plan: P.Plan = kind === 'flat' ? { kind, rate: Number(b.rate) / 100 }
    : { kind, tiers: (Array.isArray(b.tiers) ? b.tiers : []).map((t: any) => ({ upTo: t.upTo === null || t.upTo === '' || t.upTo === undefined ? null : money(t.upTo, 'Tier limit'), rate: Number(t.rate) / 100 })) };
  if (b.cap !== undefined && b.cap !== null && b.cap !== '') plan.capCents = money(b.cap, 'Cap');
  const errs = P.validatePlan(plan); if (errs.length) throw bad(errs[0]);
  const draw = b.draw ? money(b.draw, 'Draw', true) : 0, name = str(b.name, 2, 80, 'Plan name');
  await M.CommissionPlan.update({ active: false } as any, { where: { employeeId: e.id, active: true } });
  const row: any = await M.CommissionPlan.create({ employeeId: e.id, name, kind, rate: plan.rate ?? null, tiers: plan.tiers ?? null, capCents: plan.capCents ?? null, drawCents: draw, active: true, createdBy: q.user.id } as any);
  await log(q.user.id, 'Commission Plan Assigned', `employee #${e.id} ${name}`); s.json(row);
}));
R.get('/sales', wrap(async (q, s) => s.json(await named(await M.Sale.findAll({ where: await mine(q), order: [['saleDate', 'DESC'], ['id', 'DESC']], limit: 300 })))));
R.post('/sales', wrap(async (q, s) => {
  const b = q.body || {}, empId = Number(b.employeeId) || q.user.id; await getEmp(empId);
  if (empId !== q.user.id && (await approverCheck(q.user, empId)) !== 'ok') return s.status(403).json({ error: 'Not allowed for this employee' });
  const plan: any = await M.CommissionPlan.findOne({ where: { employeeId: empId, active: true } }); if (!plan) throw bad('This employee has no active commission plan');
  if (!DATE.test(String(b.saleDate || '')) || b.saleDate > today()) throw bad('Sale date must be a valid date that is not in the future');
  const split = Number(b.splitPct ?? 100); if (!(split >= 1 && split <= 100)) throw bad('Split must be between 1 and 100');
  if (await M.CommissionLine.findOne({ where: { employeeId: empId, period: b.saleDate.slice(0, 7), status: { [Op.in]: ['approved', 'locked'] } } })) throw bad('Commission for that month is already approved. Ask HR to return it first.');
  const row: any = await M.Sale.create({ employeeId: empId, planId: plan.id, saleDate: b.saleDate, amountCents: money(b.amount, 'Sale amount'), splitPct: split, description: str(b.description, 2, 200, 'Description'), enteredBy: q.user.id } as any);
  await log(q.user.id, 'Sale Recorded', `#${row.id} employee #${empId}`); s.json(row);
}));
R.post('/sales/:id/refund', hr, wrap(async (q, s) => {
  const x: any = await M.Sale.findByPk(Number(q.params.id) || 0); if (!x) throw bad('Sale not found', 404);
  const refund = money(q.body?.refund, 'Refund'); if (refund > x.amountCents) throw bad('Refund cannot be more than the sale');
  await x.update({ refundCents: refund, refundedAt: today(), clawbackPeriod: null });
  await log(q.user.id, 'Sale Refunded', `#${x.id} ${refund / 100}`); s.json({ ok: true });
}));

// ---------------- P9 calculate, review, approve ----------------
R.post('/commission/calculate', hr, wrap(async (q, s) => {
  const period = String(q.body?.period || ''); if (!PERIOD.test(period)) throw bad('period must look like 2026-11');
  const [from, to] = bounds(period); let made = 0, skipped = 0;
  for (const plan of (await M.CommissionPlan.findAll({ where: { active: true } })) as any[]) {
    const emp: any = await M.Employee.findByPk(plan.employeeId); if (!emp || emp.status === 'terminated') continue;
    const existing: any = await M.CommissionLine.findOne({ where: { employeeId: plan.employeeId, period } });
    if (existing && !['draft', 'returned'].includes(existing.status)) { skipped++; continue; }
    const sales: any[] = await M.Sale.findAll({ where: { employeeId: plan.employeeId, saleDate: { [Op.between]: [from, to] } } });
    const credited = P.creditedSales(sales.map((x) => ({ amountCents: x.amountCents, splitPct: x.splitPct })));
    const earned = P.commissionFor(credited, { kind: plan.kind, rate: plan.rate == null ? undefined : Number(plan.rate), tiers: plan.tiers || undefined, capCents: plan.capCents });
    for (const x of sales) await x.update({ commissionPaidCents: credited ? Math.round(earned * Math.round(x.amountCents * x.splitPct / 100) / credited) : 0 });
    const prev: any = await M.CommissionLine.findOne({ where: { employeeId: plan.employeeId, period: { [Op.lt]: period } }, order: [['period', 'DESC']] });
    const dr = P.applyDraw(earned, plan.drawCents || 0, prev?.shortfallCents || 0);
    const refunds: any[] = await M.Sale.findAll({ where: { employeeId: plan.employeeId, refundCents: { [Op.gt]: 0 }, refundedAt: { [Op.lte]: to }, [Op.or]: [{ clawbackPeriod: null }, { clawbackPeriod: period }] } });
    let claw = 0; for (const x of refunds) { claw += P.clawbackLine(x.commissionPaidCents, x.amountCents, x.refundCents); await x.update({ clawbackPeriod: period }); }
    const data = { employeeId: plan.employeeId, period, creditedCents: credited, earnedCents: earned, drawCents: dr.drawPaid, extraCents: dr.extraPaid, shortfallCents: dr.shortfallOut, clawbackCents: claw, payableCents: dr.drawPaid + dr.extraPaid + claw, status: 'draft', comment: null };
    if (existing) await existing.update(data); else await M.CommissionLine.create(data as any);
    made++;
  }
  await log(q.user.id, 'Commission Calculated', `${period} lines:${made} skipped:${skipped}`); s.json({ ok: true, lines: made, skipped });
}));
R.get('/commission/lines', wrap(async (q, s) => s.json(await named(await M.CommissionLine.findAll({ where: await mine(q), order: [['period', 'DESC'], ['id', 'DESC']], limit: 300 })))));
R.post('/commission/lines/:id/decide', staff, wrap(async (q, s) => {
  const l: any = await M.CommissionLine.findByPk(Number(q.params.id) || 0); if (!l) throw bad('Line not found', 404);
  const ok = await approverCheck(q.user, l.employeeId); if (ok === 'self') throw bad('You cannot approve your own commission', 403); if (ok === 'forbidden') throw bad('Not your team', 403);
  if (l.status !== 'draft') throw bad('This statement was already decided');
  const approve = q.body?.approve === true, comment = String(q.body?.comment || '').trim(); if (!approve && comment.length < 3) throw bad('Add a comment when returning a statement');
  await l.update({ status: approve ? 'approved' : 'returned', comment: comment || null, decidedBy: q.user.id });
  await log(q.user.id, approve ? 'Commission Approved' : 'Commission Returned', `line #${l.id} ${l.period}`); s.json(l);
}));

// ---------------- P18 bonuses ----------------
R.get('/bonuses', wrap(async (q, s) => s.json(await named(await M.Bonus.findAll({ where: await mine(q), order: [['id', 'DESC']], limit: 300 })))));
R.post('/bonuses', staff, wrap(async (q, s) => {
  const b = q.body || {}, e = await getEmp(b.employeeId), chk = await approverCheck(q.user, e.id);
  if (chk === 'self') throw bad('You cannot propose a bonus for yourself', 403); if (chk === 'forbidden') throw bad('Not your team', 403);
  const kind = ['annual', 'spot', 'signing', 'retention', 'referral'].includes(b.kind) ? b.kind : null; if (!kind) throw bad('Choose a bonus type');
  if (!PERIOD.test(String(b.payPeriod || ''))) throw bad('Pay period must look like 2026-12');
  const win = Number(b.windowMonths ?? 12); if (!Number.isInteger(win) || win < 0 || win > 60) throw bad('Clawback window must be 0 to 60 months');
  const row: any = await M.Bonus.create({ employeeId: e.id, kind, amountCents: money(b.amount, 'Bonus amount'), discretionary: b.discretionary !== false, reason: str(b.reason, 3, 300, 'Reason'), payPeriod: b.payPeriod, proposedBy: q.user.id, clawbackWindowMonths: win, agreementOnFile: b.agreementOnFile === true } as any);
  await log(q.user.id, 'Bonus Proposed', `#${row.id} employee #${e.id}`); s.json(row);
}));
R.post('/bonuses/:id/decide', hr, wrap(async (q, s) => {
  const x: any = await M.Bonus.findByPk(Number(q.params.id) || 0); if (!x) throw bad('Bonus not found', 404);
  if (x.status !== 'proposed') throw bad('This bonus was already decided');
  if (x.employeeId === q.user.id) throw bad('You cannot approve your own bonus', 403); if (x.proposedBy === q.user.id) throw bad('Another person must approve this bonus', 403);
  const approve = q.body?.approve === true, comment = String(q.body?.comment || '').trim(); if (!approve && comment.length < 3) throw bad('Add a comment when rejecting');
  let withholding = 0;
  if (approve) { // flat supplemental method, YTD of this employee's other approved or paid bonuses
    const others: any[] = await M.Bonus.findAll({ where: { employeeId: x.employeeId, id: { [Op.ne]: x.id }, status: { [Op.in]: ['approved', 'paid'] }, payPeriod: { [Op.like]: `${String(x.payPeriod).slice(0, 4)}-%` } }, raw: true });
    withholding = P.supplementalWithholding(x.amountCents, others.reduce((a, o) => a + o.amountCents, 0));
  }
  await x.update({ status: approve ? 'approved' : 'rejected', decidedBy: q.user.id, comment: comment || null, withholdingCents: withholding });
  await log(q.user.id, approve ? 'Bonus Approved' : 'Bonus Rejected', `#${x.id}`); s.json(x);
}));
R.post('/bonuses/:id/clawback', hr, wrap(async (q, s) => {
  const x: any = await M.Bonus.findByPk(Number(q.params.id) || 0); if (!x) throw bad('Bonus not found', 404);
  if (x.status !== 'paid') throw bad('Only a paid bonus can be recovered');
  const months = Math.max(0, Math.floor((Date.now() - new Date(x.paidAt).getTime()) / (30.44 * 864e5)));
  const d = P.clawbackDecision({ agreementOnFile: !!x.agreementOnFile, monthsSincePaid: months, windowMonths: x.clawbackWindowMonths, stateRestrictsDeduction: q.body?.stateRestrictsDeduction === true });
  if (!d.allowed) throw bad(d.reason);
  await x.update({ status: 'clawed_back', clawbackMethod: d.method, comment: str(q.body?.reason, 3, 300, 'Reason') });
  await log(q.user.id, 'Bonus Clawback', `#${x.id} via ${d.method}`); s.json({ ok: true, method: d.method, note: d.reason });
}));

// ---------------- P17 pay changes ----------------
R.get('/pay-changes', wrap(async (q, s) => { await applyDuePayChanges(); s.json(await named(await M.PayChange.findAll({ where: await mine(q), order: [['id', 'DESC']], limit: 300 }))); }));
R.post('/pay-changes', staff, wrap(async (q, s) => {
  const b = q.body || {}, e = await getEmp(b.employeeId), chk = await approverCheck(q.user, e.id);
  if (chk === 'self') throw bad('You cannot propose your own pay change', 403); if (chk === 'forbidden') throw bad('Not your team', 403);
  const payType = b.payType === 'salary' ? 'salary' : 'hourly', exempt = b.flsaExempt === true;
  if (exempt && payType !== 'salary') throw bad('Exempt employees must be paid a salary');
  const hourlyCents = payType === 'hourly' ? money(b.hourlyRate, 'Hourly rate') : 0, annualCents = payType === 'salary' ? money(b.annualSalary, 'Annual salary') : hourlyCents * 2080;
  if (!DATE.test(String(b.effectiveDate || ''))) throw bad('Effective date is required');
  const band = b.bandMin && b.bandMax ? { min: money(b.bandMin, 'Band minimum'), max: money(b.bandMax, 'Band maximum') } : undefined;
  const chkPay = P.checkPay({ exempt, annualCents, state: e.workState || 'US', band });
  if (!chkPay.ok) throw bad(chkPay.errors[0]);
  const row: any = await M.PayChange.create({ employeeId: e.id, proposedBy: q.user.id, payType, hourlyCents, annualCents, flsaExempt: exempt, effectiveDate: b.effectiveDate, reason: str(b.reason, 3, 300, 'Reason'), warnings: chkPay.warnings } as any);
  await log(q.user.id, 'Pay Change Proposed', `#${row.id} employee #${e.id}`); s.json(row);
}));
R.post('/pay-changes/:id/decide', hr, wrap(async (q, s) => {
  const c: any = await M.PayChange.findByPk(Number(q.params.id) || 0); if (!c) throw bad('Pay change not found', 404);
  if (c.status !== 'pending') throw bad('This pay change was already decided');
  if (c.employeeId === q.user.id) throw bad('You cannot approve your own pay change', 403); if (c.proposedBy === q.user.id) throw bad('Another person must approve this pay change', 403);
  const approve = q.body?.approve === true, comment = String(q.body?.comment || '').trim();
  if (approve && q.body?.budgetApproved !== true) throw bad('Confirm the budget is approved first');
  if (!approve && comment.length < 3) throw bad('Add a comment when rejecting');
  await c.update({ status: approve ? 'approved' : 'rejected', budgetApproved: approve, decidedBy: q.user.id, comment: comment || null });
  if (approve) await applyDuePayChanges();
  await log(q.user.id, approve ? 'Pay Change Approved' : 'Pay Change Rejected', `#${c.id}`); s.json(await M.PayChange.findByPk(c.id));
}));
void isHR;
