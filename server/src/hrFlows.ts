/** P19 part-time review + schedules, P16 paid sick leave accrual, P15 benefit plans, enrollment windows and life events. */
import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import { log, isHR, isStaff, teamOf, scopeIds, inScope } from './services';
import { wrap, bad, hr, staff } from './http';
import * as H from './hrCore';
import * as B from './benefitCore';
import { isoDate, todayStr, addDays } from './lifecycleCore';

export const hrFlowsRouter = Router();
const num = (v: any) => Number(v) || 0;
const names = async (ids: number[]) => new Map(((await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids)] } }, attributes: ['id', 'name'], raw: true })) as any[]).map((x) => [x.id, x.name]));
const notifyUser = (userId: number, title: string, body: string) => M.Notification.create({ userId, kind: 'hr', title, body, entityType: 'employee', entityId: userId } as any).catch(() => null);
const cityOf = (e: any) => String(e?.profile?.city || '').trim();
/** Approved timesheet hours whose period starts in [from, to]. */
async function hoursIn(employeeId: number, from: string, to: string) {
  const rows: any[] = await M.Timesheet.findAll({ where: { employeeId, status: 'approved', periodStart: { [Op.between]: [from, to] } }, raw: true });
  return rows.reduce((a, x) => a + num(x.regularHours) + num(x.otHours) + num(x.dtHours), 0);
}
const recentWeekly = async (employeeId: number) => (await hoursIn(employeeId, addDays(todayStr(), -91), todayStr())) / 13;   // rolling 13-week average (ACA look-back style)

// ================= P19 part-time =================
async function ptStatus(e: any) {
  const t = todayStr(), y = Number(t.slice(0, 4)), months = e.startDate ? Math.max(0, Math.floor((Date.parse(t) - Date.parse(e.startDate)) / (30.4375 * 864e5))) : 0;
  return H.partTimeStatus({ type: e.type, hours12m: await hoursIn(e.id, addDays(t, -365), t), monthsService: months, hoursYear1: await hoursIn(e.id, `${y - 1}-01-01`, `${y - 1}-12-31`), hoursYear2: await hoursIn(e.id, `${y - 2}-01-01`, `${y - 2}-12-31`) });
}
hrFlowsRouter.get('/part-time/review', hr, wrap(async (_q, s) => {
  const emps: any[] = await M.Employee.findAll({ where: { type: 'part_time', status: { [Op.ne]: 'terminated' } }, attributes: ['id', 'name', 'type', 'startDate', 'workState'] });
  const q = H ? todayStr().slice(0, 4) + '-Q' + Math.floor((Number(todayStr().slice(5, 7)) - 1) / 3 + 1) : '';
  const done: any[] = await M.PartTimeReview.findAll({ where: { quarter: q }, raw: true });
  s.json({ quarter: q, rows: await Promise.all(emps.map(async (e) => ({ employeeId: e.id, name: e.name, ...(await ptStatus(e)), reviewedThisQuarter: done.some((d) => d.employeeId === e.id) }))) });
}));
hrFlowsRouter.post('/part-time/review/:id', hr, wrap(async (q, s) => {
  const id = Number(q.params.id), e: any = await M.Employee.findByPk(id); if (!e || e.type !== 'part_time') throw bad('Part-time employee not found', 404);
  if (id === q.user.id) throw bad('You cannot review your own classification', 403);
  const decision = String(q.body.decision || ''), note = String(q.body.note || '').trim();
  if (!['keep', 'reclassify'].includes(decision)) throw bad('decision must be keep or reclassify'); if (note.length < 5) throw bad('A note is required');
  const st = await ptStatus(e), quarter = B.quarterOf(todayStr());
  if (decision === 'reclassify' && !st.reclassify) throw bad(`Average hours (${st.avgWeekly} a week) do not reach the 30-hour full-time threshold`);
  if (await M.PartTimeReview.findOne({ where: { employeeId: id, quarter } })) throw bad('This employee was already reviewed this quarter', 409);
  const r: any = await M.PartTimeReview.create({ employeeId: id, quarter, avgWeekly: st.avgWeekly, aca: st.aca, decision, note, decidedBy: q.user.id } as any);
  if (decision === 'reclassify') { await M.Employee.update({ type: 'full_time' } as any, { where: { id } }); await notifyUser(id, 'Your employment classification changed', 'You are now classified as full-time. HR will send your written notice and benefits eligibility information.'); }
  await log(q.user.id, decision === 'reclassify' ? 'Part-time Reclassified' : 'Part-time Reviewed', `employee #${id} ${quarter} avg ${st.avgWeekly} h/week`); s.status(201).json(r);
}));
hrFlowsRouter.get('/part-time/reviews', hr, wrap(async (_q, s) => { const rows: any[] = await M.PartTimeReview.findAll({ order: [['id', 'DESC']], limit: 200, raw: true }); const nm = await names(rows.map((x) => x.employeeId)); s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) }))); }));

// schedules: publish with advance notice where local law requires; every change is logged (A5)
hrFlowsRouter.get('/schedules', wrap(async (q, s) => {
  const rows: any[] = await M.SchedulePost.findAll({ where: inScope(await scopeIds(q.user)), order: [['weekStart', 'DESC']], limit: 200, raw: true }); const nm = await names(rows.map((x) => x.employeeId));
  s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
async function mayManage(u: any, employeeId: number) { return isHR(u) || (u.role === 'manager' && (await teamOf(u.id)).includes(employeeId)); }
hrFlowsRouter.post('/schedules', staff, wrap(async (q, s) => {
  const eid = Number(q.body.employeeId), week = isoDate(q.body.weekStart), shifts = String(q.body.shifts || '').trim();
  const e: any = await M.Employee.findByPk(eid); if (!e || e.status === 'terminated') throw bad('Employee not found', 404);
  if (!(await mayManage(q.user, eid))) throw bad('Not allowed for your role', 403); if (eid === q.user.id) throw bad('You cannot publish your own schedule', 403);
  if (!week) throw bad('Enter the week start date'); if (!shifts) throw bad('Enter the shifts');
  if (await M.SchedulePost.findOne({ where: { employeeId: eid, weekStart: week } })) throw bad('A schedule is already published for that week: record a change instead', 409);
  const nd = H.noticeDays(cityOf(e) || e.workState), days = Math.floor((Date.parse(week) - Date.parse(todayStr())) / 864e5);
  const p: any = await M.SchedulePost.create({ employeeId: eid, weekStart: week, shifts, publishedAt: new Date(), publishedBy: q.user.id, noticeDays: nd, lateNotice: days < nd, changeLog: [] } as any);
  await notifyUser(eid, 'Your schedule is published', `Week of ${week}`); await log(q.user.id, 'Schedule Published', `employee #${eid} week ${week}${days < nd ? ' (late notice)' : ''}`); s.status(201).json(p);
}));
hrFlowsRouter.post('/schedules/:id/change', staff, wrap(async (q, s) => {
  const p: any = await M.SchedulePost.findByPk(Number(q.params.id)); if (!p) throw bad('Not found', 404);
  if (!(await mayManage(q.user, p.employeeId))) throw bad('Not allowed for your role', 403);
  const shifts = String(q.body.shifts || '').trim(), reason = String(q.body.reason || '').trim(); if (!shifts) throw bad('Enter the new shifts'); if (reason.length < 3) throw bad('A reason is required');
  const days = Math.floor((Date.parse(p.weekStart) - Date.parse(todayStr())) / 864e5), late = days < p.noticeDays;
  const entry = { at: new Date().toISOString(), by: q.user.id, reason, from: p.shifts, to: shifts, daysBefore: days, lateChange: late };
  await p.update({ shifts, changeLog: [...(p.changeLog || []), entry] });
  await notifyUser(p.employeeId, 'Your schedule changed', `Week of ${p.weekStart}: ${reason}`); await log(q.user.id, 'Schedule Changed', `#${p.id}${late ? ' (inside the notice window: check predictive-scheduling pay rules)' : ''}`); s.json(p);
}));

// ================= P16 paid sick leave =================
async function pslRules() { return (await M.ComplianceRule.findAll({ where: { key: 'psl' }, raw: true })) as any[]; }
const pslFor = (rules: any[], e: any, date: string) => H.ruleAt(rules, 'psl', [`${String(e.workState || '').toUpperCase()}:${cityOf(e)}`, String(e.workState || '').toUpperCase()].filter((x) => !x.endsWith(':')), date);
/** Used by the leave route: paid sick leave may be used only after the waiting period of the jurisdiction's rule. */
export async function sickWaitingError(e: any, leaveStart: string): Promise<string | null> {
  const r: any = pslFor(await pslRules(), e, leaveStart); if (!r || !e.startDate || !(r.value.waitingDays > 0)) return null;
  const from = B.pslUsableFrom(e.startDate, r.value.waitingDays); return leaveStart < from ? `Paid sick leave can be used from ${from} (waiting period of ${r.value.waitingDays} days)` : null;
}
hrFlowsRouter.post('/compliance-rules/seed-psl', hr, wrap(async (q, s) => {
  const have = new Set((await pslRules()).map((r) => r.jurisdiction)); let created = 0;
  for (const x of B.PSL_SEED) if (!have.has(x.jurisdiction)) { await M.ComplianceRule.create({ key: 'psl', jurisdiction: x.jurisdiction, effectiveDate: '2026-01-01', version: 1, value: x.value, sourceUrl: 'BPMN Appendix A2 (compiled 13 Nov 2026)', legalOwner: '', verified: false, createdBy: q.user.id } as any); created++; }
  await log(q.user.id, 'PSL Rules Seeded', `${created} jurisdictions from Appendix A2 (unverified)`); s.json({ created, skipped: B.PSL_SEED.length - created, note: 'Loaded from the BPMN Appendix A2 as UNVERIFIED. Confirm each state with counsel and add a verified version.' });
}));
hrFlowsRouter.post('/sick-leave/accrue', hr, wrap(async (q, s) => {
  const ps = isoDate(q.body.periodStart), pe = isoDate(q.body.periodEnd); if (!ps || !pe || pe < ps) throw bad('Choose a valid pay period');
  const rules = await pslRules(), emps: any[] = await M.Employee.findAll({ where: { status: { [Op.in]: ['active', 'onboarding'] } } }), size = emps.length, year = pe.slice(0, 4);
  const out: any = { accrued: [], noRule: [], alreadyDone: 0, review: [] };
  for (const e of emps) {
    const rule: any = pslFor(rules, e, pe); if (!rule) { out.noRule.push(e.name); continue; }
    if (await M.PslLedger.findOne({ where: { employeeId: e.id, kind: 'accrual', periodStart: ps, periodEnd: pe } })) { out.alreadyDone++; continue; }
    const worked = await hoursIn(e.id, ps, pe), done: any[] = await M.PslLedger.findAll({ where: { employeeId: e.id, kind: 'accrual', periodEnd: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } }, raw: true });
    const r = B.pslAccrue({ rule: rule.value, employerSize: size, hoursWorked: worked, accruedThisYear: done.reduce((a, x) => a + num(x.accrued), 0) });
    if (r.review.length) out.review.push(`${e.name}: ${r.review.join('; ')}`);
    await M.PslLedger.create({ employeeId: e.id, kind: 'accrual', periodStart: ps, periodEnd: pe, hoursWorked: worked, accrued: r.accrued, ruleJurisdiction: rule.jurisdiction, ruleVersion: rule.version, note: r.capped ? 'annual cap reached' : '' } as any);
    if (r.accrued > 0) { const [b]: any = await M.LeaveBalance.findOrCreate({ where: { employeeId: e.id, type: 'Sick' }, defaults: { employeeId: e.id, type: 'Sick', total: 0 } as any }); await b.update({ total: num(b.total) + r.accrued }); out.accrued.push({ employee: e.name, hours: r.accrued, rule: `${rule.jurisdiction} v${rule.version}`, verified: !!rule.verified }); }
  }
  await log(q.user.id, 'PSL Accrued', `${ps}..${pe} employees:${out.accrued.length}`); s.json(out);
}));
hrFlowsRouter.post('/sick-leave/year-end', hr, wrap(async (q, s) => {
  const year = Number(q.body.year); if (!(year >= 2000 && year <= 2100)) throw bad('Choose a year');
  const rules = await pslRules(), emps: any[] = await M.Employee.findAll({ where: { status: { [Op.ne]: 'terminated' } } }), out: any = { reset: 0, noRule: 0, alreadyDone: 0, review: [] };
  for (const e of emps) {
    const rule: any = pslFor(rules, e, `${year}-12-31`); if (!rule) { out.noRule++; continue; }
    const b: any = await M.LeaveBalance.findOne({ where: { employeeId: e.id, type: 'Sick' } }); if (!b) continue;
    if (await M.PslLedger.findOne({ where: { employeeId: e.id, kind: 'year_end', periodStart: `${year}-12-31`, periodEnd: `${year}-12-31` } })) { out.alreadyDone++; continue; }
    const r = B.pslYearEnd(rule.value, Math.max(0, num(b.total) - num(b.used) - num(b.pending))); if (r.review.length) out.review.push(`${e.name}: ${r.review.join('; ')}`);
    await b.update({ total: r.carry + num(b.pending), used: 0 });
    await M.PslLedger.create({ employeeId: e.id, kind: 'year_end', periodStart: `${year}-12-31`, periodEnd: `${year}-12-31`, hoursWorked: 0, accrued: 0, ruleJurisdiction: rule.jurisdiction, ruleVersion: rule.version, note: `carried ${r.carry} h` } as any); out.reset++;
  }
  await log(q.user.id, 'PSL Year-end', `${year} reset:${out.reset}`); s.json(out);
}));
hrFlowsRouter.get('/sick-leave/ledger', wrap(async (q, s) => {
  const where: any = isHR(q.user) ? (q.query.employeeId ? { employeeId: Number(q.query.employeeId) } : {}) : { employeeId: q.user.id };
  const rows: any[] = await M.PslLedger.findAll({ where, order: [['id', 'DESC']], limit: 300, raw: true }); const nm = await names(rows.map((x) => x.employeeId)); s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));

// ================= P15 plans, windows, life events =================
hrFlowsRouter.get('/benefits/catalog', wrap(async (_q, s) => { const plans: any[] = await M.BenefitPlan.findAll({ raw: true }); s.json(H.BENEFITS.map((name, i) => ({ no: i + 1, name, plans: plans.filter((p) => p.catalogItem === name).length }))); }));
const planBody = (b: any) => {
  const code = String(b.code || '').toLowerCase(), cost = b.cost || {};
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(code)) throw bad('Plan code: 2-40 letters, numbers or dashes'); if (!H.BENEFITS.includes(b.catalogItem)) throw bad('Choose a benefit from the catalog');
  if (!String(b.name || '').trim()) throw bad('Plan name is required'); const pct = Number(b.employerPct); if (!(pct >= 0 && pct <= 100)) throw bad('Employer share must be 0-100');
  for (const k of ['employee', 'spouse', 'children', 'family']) if (!(Number(cost[k]) >= 0)) throw bad(`Monthly cost for ${k} must be 0 or more`);
  const minHours = Number(b.minHours ?? 30), waitingDays = Number(b.waitingDays ?? 30), windowDays = Number(b.windowDays ?? 30);
  if (!(minHours >= 0 && minHours <= 60) || !(waitingDays >= 0 && waitingDays <= 365) || !(windowDays >= 1 && windowDays <= 120)) throw bad('Check hours (0-60), waiting days (0-365) and window days (1-120)');
  return { code, name: String(b.name).trim().slice(0, 160), catalogItem: b.catalogItem, employerPct: pct, minHours, waitingDays, windowDays, preTax: !!b.preTax, cost: { employee: Number(cost.employee), spouse: Number(cost.spouse), children: Number(cost.children), family: Number(cost.family) } };
};
hrFlowsRouter.get('/benefit-plans', wrap(async (q, s) => s.json(await M.BenefitPlan.findAll({ where: isHR(q.user) ? {} : { active: true }, order: [['name', 'ASC']] }))));
hrFlowsRouter.post('/benefit-plans', hr, wrap(async (q, s) => {
  const v = planBody(q.body); if (await M.BenefitPlan.findOne({ where: { code: v.code } })) throw bad('That plan code already exists', 409);
  const p: any = await M.BenefitPlan.create(v as any); await log(q.user.id, 'Benefit Plan Created', `${v.code} (${v.catalogItem})`); s.status(201).json(p);
}));
hrFlowsRouter.patch('/benefit-plans/:id', hr, wrap(async (q, s) => {
  const p: any = await M.BenefitPlan.findByPk(Number(q.params.id)); if (!p) throw bad('Not found', 404);
  const v = planBody({ ...p.toJSON(), ...q.body, code: p.code }); await p.update({ ...v, active: q.body.active === undefined ? p.active : !!q.body.active });
  await log(q.user.id, 'Benefit Plan Updated', `${p.code} (applies to NEW enrollments only)`); s.json(p);
}));
hrFlowsRouter.get('/enrollment-windows', wrap(async (q, s) => {
  const where: any = isHR(q.user) ? {} : { [Op.or]: [{ kind: 'open' }, { employeeId: q.user.id }] };
  const rows: any[] = await M.EnrollmentWindow.findAll({ where, order: [['id', 'DESC']], limit: 200, raw: true }); const nm = await names(rows.filter((x) => x.employeeId).map((x) => x.employeeId));
  s.json(rows.map((x) => ({ ...x, employeeName: x.employeeId ? nm.get(x.employeeId) : null })));
}));
hrFlowsRouter.post('/enrollment-windows', hr, wrap(async (q, s) => {
  const a = isoDate(q.body.startDate), b = isoDate(q.body.endDate); if (!a || !b || b < a) throw bad('Choose a valid start and end date');
  if ((Date.parse(b) - Date.parse(a)) / 864e5 > 60) throw bad('An open enrollment window can be at most 60 days');
  const w: any = await M.EnrollmentWindow.create({ kind: 'open', startDate: a, endDate: b, createdBy: q.user.id } as any); await log(q.user.id, 'Open Enrollment Created', `${a}..${b}`); s.status(201).json(w);
}));
hrFlowsRouter.post('/enrollment-windows/:id/void', hr, wrap(async (q, s) => {
  const [n] = await M.EnrollmentWindow.update({ voidedAt: new Date() } as any, { where: { id: Number(q.params.id), voidedAt: null } }); if (!n) throw bad('Not found or already voided', 404);
  await log(q.user.id, 'Enrollment Window Voided', `#${q.params.id}`); s.json({ ok: true });
}));
/** Marriage, birth/adoption or loss of other coverage reopens enrollment for that employee (normally 30 days). */
hrFlowsRouter.post('/life-events', wrap(async (q, s) => {
  const target = q.body.employeeId && isHR(q.user) ? Number(q.body.employeeId) : q.user.id, event = String(q.body.event || ''), date = isoDate(q.body.eventDate);
  if (!(B.LIFE_EVENTS as readonly string[]).includes(event)) throw bad('Choose marriage, birth/adoption or loss of other coverage'); if (!date) throw bad('Enter the event date');
  const t = todayStr(); if (date < addDays(t, -30) || date > addDays(t, 30)) throw bad('The event must be within 30 days of today');
  const e: any = await M.Employee.findByPk(target); if (!e || e.status === 'terminated') throw bad('Employee not found', 404);
  if (await M.EnrollmentWindow.findOne({ where: { kind: 'life_event', employeeId: target, event, startDate: date, voidedAt: null } })) throw bad('This life event is already recorded', 409);
  const w: any = await M.EnrollmentWindow.create({ kind: 'life_event', employeeId: target, event, startDate: date, endDate: addDays(date, 30), createdBy: q.user.id } as any);
  await log(q.user.id, 'Life Event Recorded', `employee #${target} ${event}`); s.status(201).json(w);
}));
/** Used by POST /benefits: is enrollment open for this employee today, and why. */
export async function enrollmentOpen(e: any, eligibleDate: string, windowDays: number) {
  const ws: any[] = await M.EnrollmentWindow.findAll({ where: { voidedAt: null, [Op.or]: [{ kind: 'open' }, { employeeId: e.id }] }, raw: true });
  return B.windowState({ today: todayStr(), eligibleDate, windowDays, openWindows: ws.filter((w) => w.kind === 'open'), lifeEvents: ws.filter((w) => w.kind === 'life_event').map((w) => ({ eventDate: w.startDate })) });
}
export { recentWeekly };
