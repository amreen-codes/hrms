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
exports.recentWeekly = exports.hrFlowsRouter = void 0;
exports.sickWaitingError = sickWaitingError;
exports.enrollmentOpen = enrollmentOpen;
/** P19 part-time review + schedules, P16 paid sick leave accrual, P15 benefit plans, enrollment windows and life events. */
const express_1 = require("express");
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
const H = __importStar(require("./hrCore"));
const B = __importStar(require("./benefitCore"));
const lifecycleCore_1 = require("./lifecycleCore");
exports.hrFlowsRouter = (0, express_1.Router)();
const num = (v) => Number(v) || 0;
const names = async (ids) => new Map((await M.Employee.findAll({ where: { id: { [sequelize_1.Op.in]: [...new Set(ids)] } }, attributes: ['id', 'name'], raw: true })).map((x) => [x.id, x.name]));
const notifyUser = (userId, title, body) => M.Notification.create({ userId, kind: 'hr', title, body, entityType: 'employee', entityId: userId }).catch(() => null);
const cityOf = (e) => String(e?.profile?.city || '').trim();
/** Approved timesheet hours whose period starts in [from, to]. */
async function hoursIn(employeeId, from, to) {
    const rows = await M.Timesheet.findAll({ where: { employeeId, status: 'approved', periodStart: { [sequelize_1.Op.between]: [from, to] } }, raw: true });
    return rows.reduce((a, x) => a + num(x.regularHours) + num(x.otHours) + num(x.dtHours), 0);
}
const recentWeekly = async (employeeId) => (await hoursIn(employeeId, (0, lifecycleCore_1.addDays)((0, lifecycleCore_1.todayStr)(), -91), (0, lifecycleCore_1.todayStr)())) / 13; // rolling 13-week average (ACA look-back style)
exports.recentWeekly = recentWeekly;
// ================= P19 part-time =================
async function ptStatus(e) {
    const t = (0, lifecycleCore_1.todayStr)(), y = Number(t.slice(0, 4)), months = e.startDate ? Math.max(0, Math.floor((Date.parse(t) - Date.parse(e.startDate)) / (30.4375 * 864e5))) : 0;
    return H.partTimeStatus({ type: e.type, hours12m: await hoursIn(e.id, (0, lifecycleCore_1.addDays)(t, -365), t), monthsService: months, hoursYear1: await hoursIn(e.id, `${y - 1}-01-01`, `${y - 1}-12-31`), hoursYear2: await hoursIn(e.id, `${y - 2}-01-01`, `${y - 2}-12-31`) });
}
exports.hrFlowsRouter.get('/part-time/review', http_1.hr, (0, http_1.wrap)(async (_q, s) => {
    const emps = await M.Employee.findAll({ where: { type: 'part_time', status: { [sequelize_1.Op.ne]: 'terminated' } }, attributes: ['id', 'name', 'type', 'startDate', 'workState'] });
    const q = H ? (0, lifecycleCore_1.todayStr)().slice(0, 4) + '-Q' + Math.floor((Number((0, lifecycleCore_1.todayStr)().slice(5, 7)) - 1) / 3 + 1) : '';
    const done = await M.PartTimeReview.findAll({ where: { quarter: q }, raw: true });
    s.json({ quarter: q, rows: await Promise.all(emps.map(async (e) => ({ employeeId: e.id, name: e.name, ...(await ptStatus(e)), reviewedThisQuarter: done.some((d) => d.employeeId === e.id) }))) });
}));
exports.hrFlowsRouter.post('/part-time/review/:id', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const id = Number(q.params.id), e = await M.Employee.findByPk(id);
    if (!e || e.type !== 'part_time')
        throw (0, http_1.bad)('Part-time employee not found', 404);
    if (id === q.user.id)
        throw (0, http_1.bad)('You cannot review your own classification', 403);
    const decision = String(q.body.decision || ''), note = String(q.body.note || '').trim();
    if (!['keep', 'reclassify'].includes(decision))
        throw (0, http_1.bad)('decision must be keep or reclassify');
    if (note.length < 5)
        throw (0, http_1.bad)('A note is required');
    const st = await ptStatus(e), quarter = B.quarterOf((0, lifecycleCore_1.todayStr)());
    if (decision === 'reclassify' && !st.reclassify)
        throw (0, http_1.bad)(`Average hours (${st.avgWeekly} a week) do not reach the 30-hour full-time threshold`);
    if (await M.PartTimeReview.findOne({ where: { employeeId: id, quarter } }))
        throw (0, http_1.bad)('This employee was already reviewed this quarter', 409);
    const r = await M.PartTimeReview.create({ employeeId: id, quarter, avgWeekly: st.avgWeekly, aca: st.aca, decision, note, decidedBy: q.user.id });
    if (decision === 'reclassify') {
        await M.Employee.update({ type: 'full_time' }, { where: { id } });
        await notifyUser(id, 'Your employment classification changed', 'You are now classified as full-time. HR will send your written notice and benefits eligibility information.');
    }
    await (0, services_1.log)(q.user.id, decision === 'reclassify' ? 'Part-time Reclassified' : 'Part-time Reviewed', `employee #${id} ${quarter} avg ${st.avgWeekly} h/week`);
    s.status(201).json(r);
}));
exports.hrFlowsRouter.get('/part-time/reviews', http_1.hr, (0, http_1.wrap)(async (_q, s) => { const rows = await M.PartTimeReview.findAll({ order: [['id', 'DESC']], limit: 200, raw: true }); const nm = await names(rows.map((x) => x.employeeId)); s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) }))); }));
// schedules: publish with advance notice where local law requires; every change is logged (A5)
exports.hrFlowsRouter.get('/schedules', (0, http_1.wrap)(async (q, s) => {
    const rows = await M.SchedulePost.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['weekStart', 'DESC']], limit: 200, raw: true });
    const nm = await names(rows.map((x) => x.employeeId));
    s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
async function mayManage(u, employeeId) { return (0, services_1.isHR)(u) || (u.role === 'manager' && (await (0, services_1.teamOf)(u.id)).includes(employeeId)); }
exports.hrFlowsRouter.post('/schedules', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const eid = Number(q.body.employeeId), week = (0, lifecycleCore_1.isoDate)(q.body.weekStart), shifts = String(q.body.shifts || '').trim();
    const e = await M.Employee.findByPk(eid);
    if (!e || e.status === 'terminated')
        throw (0, http_1.bad)('Employee not found', 404);
    if (!(await mayManage(q.user, eid)))
        throw (0, http_1.bad)('Not allowed for your role', 403);
    if (eid === q.user.id)
        throw (0, http_1.bad)('You cannot publish your own schedule', 403);
    if (!week)
        throw (0, http_1.bad)('Enter the week start date');
    if (!shifts)
        throw (0, http_1.bad)('Enter the shifts');
    if (await M.SchedulePost.findOne({ where: { employeeId: eid, weekStart: week } }))
        throw (0, http_1.bad)('A schedule is already published for that week: record a change instead', 409);
    const nd = H.noticeDays(cityOf(e) || e.workState), days = Math.floor((Date.parse(week) - Date.parse((0, lifecycleCore_1.todayStr)())) / 864e5);
    const p = await M.SchedulePost.create({ employeeId: eid, weekStart: week, shifts, publishedAt: new Date(), publishedBy: q.user.id, noticeDays: nd, lateNotice: days < nd, changeLog: [] });
    await notifyUser(eid, 'Your schedule is published', `Week of ${week}`);
    await (0, services_1.log)(q.user.id, 'Schedule Published', `employee #${eid} week ${week}${days < nd ? ' (late notice)' : ''}`);
    s.status(201).json(p);
}));
exports.hrFlowsRouter.post('/schedules/:id/change', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const p = await M.SchedulePost.findByPk(Number(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    if (!(await mayManage(q.user, p.employeeId)))
        throw (0, http_1.bad)('Not allowed for your role', 403);
    const shifts = String(q.body.shifts || '').trim(), reason = String(q.body.reason || '').trim();
    if (!shifts)
        throw (0, http_1.bad)('Enter the new shifts');
    if (reason.length < 3)
        throw (0, http_1.bad)('A reason is required');
    const days = Math.floor((Date.parse(p.weekStart) - Date.parse((0, lifecycleCore_1.todayStr)())) / 864e5), late = days < p.noticeDays;
    const entry = { at: new Date().toISOString(), by: q.user.id, reason, from: p.shifts, to: shifts, daysBefore: days, lateChange: late };
    await p.update({ shifts, changeLog: [...(p.changeLog || []), entry] });
    await notifyUser(p.employeeId, 'Your schedule changed', `Week of ${p.weekStart}: ${reason}`);
    await (0, services_1.log)(q.user.id, 'Schedule Changed', `#${p.id}${late ? ' (inside the notice window: check predictive-scheduling pay rules)' : ''}`);
    s.json(p);
}));
// ================= P16 paid sick leave =================
async function pslRules() { return (await M.ComplianceRule.findAll({ where: { key: 'psl' }, raw: true })); }
const pslFor = (rules, e, date) => H.ruleAt(rules, 'psl', [`${String(e.workState || '').toUpperCase()}:${cityOf(e)}`, String(e.workState || '').toUpperCase()].filter((x) => !x.endsWith(':')), date);
/** Used by the leave route: paid sick leave may be used only after the waiting period of the jurisdiction's rule. */
async function sickWaitingError(e, leaveStart) {
    const r = pslFor(await pslRules(), e, leaveStart);
    if (!r || !e.startDate || !(r.value.waitingDays > 0))
        return null;
    const from = B.pslUsableFrom(e.startDate, r.value.waitingDays);
    return leaveStart < from ? `Paid sick leave can be used from ${from} (waiting period of ${r.value.waitingDays} days)` : null;
}
exports.hrFlowsRouter.post('/compliance-rules/seed-psl', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const have = new Set((await pslRules()).map((r) => r.jurisdiction));
    let created = 0;
    for (const x of B.PSL_SEED)
        if (!have.has(x.jurisdiction)) {
            await M.ComplianceRule.create({ key: 'psl', jurisdiction: x.jurisdiction, effectiveDate: '2026-01-01', version: 1, value: x.value, sourceUrl: 'BPMN Appendix A2 (compiled 13 Nov 2026)', legalOwner: '', verified: false, createdBy: q.user.id });
            created++;
        }
    await (0, services_1.log)(q.user.id, 'PSL Rules Seeded', `${created} jurisdictions from Appendix A2 (unverified)`);
    s.json({ created, skipped: B.PSL_SEED.length - created, note: 'Loaded from the BPMN Appendix A2 as UNVERIFIED. Confirm each state with counsel and add a verified version.' });
}));
exports.hrFlowsRouter.post('/sick-leave/accrue', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const ps = (0, lifecycleCore_1.isoDate)(q.body.periodStart), pe = (0, lifecycleCore_1.isoDate)(q.body.periodEnd);
    if (!ps || !pe || pe < ps)
        throw (0, http_1.bad)('Choose a valid pay period');
    const rules = await pslRules(), emps = await M.Employee.findAll({ where: { status: { [sequelize_1.Op.in]: ['active', 'onboarding'] } } }), size = emps.length, year = pe.slice(0, 4);
    const out = { accrued: [], noRule: [], alreadyDone: 0, review: [] };
    for (const e of emps) {
        const rule = pslFor(rules, e, pe);
        if (!rule) {
            out.noRule.push(e.name);
            continue;
        }
        if (await M.PslLedger.findOne({ where: { employeeId: e.id, kind: 'accrual', periodStart: ps, periodEnd: pe } })) {
            out.alreadyDone++;
            continue;
        }
        const worked = await hoursIn(e.id, ps, pe), done = await M.PslLedger.findAll({ where: { employeeId: e.id, kind: 'accrual', periodEnd: { [sequelize_1.Op.between]: [`${year}-01-01`, `${year}-12-31`] } }, raw: true });
        const r = B.pslAccrue({ rule: rule.value, employerSize: size, hoursWorked: worked, accruedThisYear: done.reduce((a, x) => a + num(x.accrued), 0) });
        if (r.review.length)
            out.review.push(`${e.name}: ${r.review.join('; ')}`);
        await M.PslLedger.create({ employeeId: e.id, kind: 'accrual', periodStart: ps, periodEnd: pe, hoursWorked: worked, accrued: r.accrued, ruleJurisdiction: rule.jurisdiction, ruleVersion: rule.version, note: r.capped ? 'annual cap reached' : '' });
        if (r.accrued > 0) {
            const [b] = await M.LeaveBalance.findOrCreate({ where: { employeeId: e.id, type: 'Sick' }, defaults: { employeeId: e.id, type: 'Sick', total: 0 } });
            await b.update({ total: num(b.total) + r.accrued });
            out.accrued.push({ employee: e.name, hours: r.accrued, rule: `${rule.jurisdiction} v${rule.version}`, verified: !!rule.verified });
        }
    }
    await (0, services_1.log)(q.user.id, 'PSL Accrued', `${ps}..${pe} employees:${out.accrued.length}`);
    s.json(out);
}));
exports.hrFlowsRouter.post('/sick-leave/year-end', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const year = Number(q.body.year);
    if (!(year >= 2000 && year <= 2100))
        throw (0, http_1.bad)('Choose a year');
    const rules = await pslRules(), emps = await M.Employee.findAll({ where: { status: { [sequelize_1.Op.ne]: 'terminated' } } }), out = { reset: 0, noRule: 0, alreadyDone: 0, review: [] };
    for (const e of emps) {
        const rule = pslFor(rules, e, `${year}-12-31`);
        if (!rule) {
            out.noRule++;
            continue;
        }
        const b = await M.LeaveBalance.findOne({ where: { employeeId: e.id, type: 'Sick' } });
        if (!b)
            continue;
        if (await M.PslLedger.findOne({ where: { employeeId: e.id, kind: 'year_end', periodStart: `${year}-12-31`, periodEnd: `${year}-12-31` } })) {
            out.alreadyDone++;
            continue;
        }
        const r = B.pslYearEnd(rule.value, Math.max(0, num(b.total) - num(b.used) - num(b.pending)));
        if (r.review.length)
            out.review.push(`${e.name}: ${r.review.join('; ')}`);
        await b.update({ total: r.carry + num(b.pending), used: 0 });
        await M.PslLedger.create({ employeeId: e.id, kind: 'year_end', periodStart: `${year}-12-31`, periodEnd: `${year}-12-31`, hoursWorked: 0, accrued: 0, ruleJurisdiction: rule.jurisdiction, ruleVersion: rule.version, note: `carried ${r.carry} h` });
        out.reset++;
    }
    await (0, services_1.log)(q.user.id, 'PSL Year-end', `${year} reset:${out.reset}`);
    s.json(out);
}));
exports.hrFlowsRouter.get('/sick-leave/ledger', (0, http_1.wrap)(async (q, s) => {
    const where = (0, services_1.isHR)(q.user) ? (q.query.employeeId ? { employeeId: Number(q.query.employeeId) } : {}) : { employeeId: q.user.id };
    const rows = await M.PslLedger.findAll({ where, order: [['id', 'DESC']], limit: 300, raw: true });
    const nm = await names(rows.map((x) => x.employeeId));
    s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
// ================= P15 plans, windows, life events =================
exports.hrFlowsRouter.get('/benefits/catalog', (0, http_1.wrap)(async (_q, s) => { const plans = await M.BenefitPlan.findAll({ raw: true }); s.json(H.BENEFITS.map((name, i) => ({ no: i + 1, name, plans: plans.filter((p) => p.catalogItem === name).length }))); }));
const planBody = (b) => {
    const code = String(b.code || '').toLowerCase(), cost = b.cost || {};
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(code))
        throw (0, http_1.bad)('Plan code: 2-40 letters, numbers or dashes');
    if (!H.BENEFITS.includes(b.catalogItem))
        throw (0, http_1.bad)('Choose a benefit from the catalog');
    if (!String(b.name || '').trim())
        throw (0, http_1.bad)('Plan name is required');
    const pct = Number(b.employerPct);
    if (!(pct >= 0 && pct <= 100))
        throw (0, http_1.bad)('Employer share must be 0-100');
    for (const k of ['employee', 'spouse', 'children', 'family'])
        if (!(Number(cost[k]) >= 0))
            throw (0, http_1.bad)(`Monthly cost for ${k} must be 0 or more`);
    const minHours = Number(b.minHours ?? 30), waitingDays = Number(b.waitingDays ?? 30), windowDays = Number(b.windowDays ?? 30);
    if (!(minHours >= 0 && minHours <= 60) || !(waitingDays >= 0 && waitingDays <= 365) || !(windowDays >= 1 && windowDays <= 120))
        throw (0, http_1.bad)('Check hours (0-60), waiting days (0-365) and window days (1-120)');
    return { code, name: String(b.name).trim().slice(0, 160), catalogItem: b.catalogItem, employerPct: pct, minHours, waitingDays, windowDays, preTax: !!b.preTax, cost: { employee: Number(cost.employee), spouse: Number(cost.spouse), children: Number(cost.children), family: Number(cost.family) } };
};
exports.hrFlowsRouter.get('/benefit-plans', (0, http_1.wrap)(async (q, s) => s.json(await M.BenefitPlan.findAll({ where: (0, services_1.isHR)(q.user) ? {} : { active: true }, order: [['name', 'ASC']] }))));
exports.hrFlowsRouter.post('/benefit-plans', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const v = planBody(q.body);
    if (await M.BenefitPlan.findOne({ where: { code: v.code } }))
        throw (0, http_1.bad)('That plan code already exists', 409);
    const p = await M.BenefitPlan.create(v);
    await (0, services_1.log)(q.user.id, 'Benefit Plan Created', `${v.code} (${v.catalogItem})`);
    s.status(201).json(p);
}));
exports.hrFlowsRouter.patch('/benefit-plans/:id', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const p = await M.BenefitPlan.findByPk(Number(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    const v = planBody({ ...p.toJSON(), ...q.body, code: p.code });
    await p.update({ ...v, active: q.body.active === undefined ? p.active : !!q.body.active });
    await (0, services_1.log)(q.user.id, 'Benefit Plan Updated', `${p.code} (applies to NEW enrollments only)`);
    s.json(p);
}));
exports.hrFlowsRouter.get('/enrollment-windows', (0, http_1.wrap)(async (q, s) => {
    const where = (0, services_1.isHR)(q.user) ? {} : { [sequelize_1.Op.or]: [{ kind: 'open' }, { employeeId: q.user.id }] };
    const rows = await M.EnrollmentWindow.findAll({ where, order: [['id', 'DESC']], limit: 200, raw: true });
    const nm = await names(rows.filter((x) => x.employeeId).map((x) => x.employeeId));
    s.json(rows.map((x) => ({ ...x, employeeName: x.employeeId ? nm.get(x.employeeId) : null })));
}));
exports.hrFlowsRouter.post('/enrollment-windows', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const a = (0, lifecycleCore_1.isoDate)(q.body.startDate), b = (0, lifecycleCore_1.isoDate)(q.body.endDate);
    if (!a || !b || b < a)
        throw (0, http_1.bad)('Choose a valid start and end date');
    if ((Date.parse(b) - Date.parse(a)) / 864e5 > 60)
        throw (0, http_1.bad)('An open enrollment window can be at most 60 days');
    const w = await M.EnrollmentWindow.create({ kind: 'open', startDate: a, endDate: b, createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'Open Enrollment Created', `${a}..${b}`);
    s.status(201).json(w);
}));
exports.hrFlowsRouter.post('/enrollment-windows/:id/void', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const [n] = await M.EnrollmentWindow.update({ voidedAt: new Date() }, { where: { id: Number(q.params.id), voidedAt: null } });
    if (!n)
        throw (0, http_1.bad)('Not found or already voided', 404);
    await (0, services_1.log)(q.user.id, 'Enrollment Window Voided', `#${q.params.id}`);
    s.json({ ok: true });
}));
/** Marriage, birth/adoption or loss of other coverage reopens enrollment for that employee (normally 30 days). */
exports.hrFlowsRouter.post('/life-events', (0, http_1.wrap)(async (q, s) => {
    const target = q.body.employeeId && (0, services_1.isHR)(q.user) ? Number(q.body.employeeId) : q.user.id, event = String(q.body.event || ''), date = (0, lifecycleCore_1.isoDate)(q.body.eventDate);
    if (!B.LIFE_EVENTS.includes(event))
        throw (0, http_1.bad)('Choose marriage, birth/adoption or loss of other coverage');
    if (!date)
        throw (0, http_1.bad)('Enter the event date');
    const t = (0, lifecycleCore_1.todayStr)();
    if (date < (0, lifecycleCore_1.addDays)(t, -30) || date > (0, lifecycleCore_1.addDays)(t, 30))
        throw (0, http_1.bad)('The event must be within 30 days of today');
    const e = await M.Employee.findByPk(target);
    if (!e || e.status === 'terminated')
        throw (0, http_1.bad)('Employee not found', 404);
    if (await M.EnrollmentWindow.findOne({ where: { kind: 'life_event', employeeId: target, event, startDate: date, voidedAt: null } }))
        throw (0, http_1.bad)('This life event is already recorded', 409);
    const w = await M.EnrollmentWindow.create({ kind: 'life_event', employeeId: target, event, startDate: date, endDate: (0, lifecycleCore_1.addDays)(date, 30), createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'Life Event Recorded', `employee #${target} ${event}`);
    s.status(201).json(w);
}));
/** Used by POST /benefits: is enrollment open for this employee today, and why. */
async function enrollmentOpen(e, eligibleDate, windowDays) {
    const ws = await M.EnrollmentWindow.findAll({ where: { voidedAt: null, [sequelize_1.Op.or]: [{ kind: 'open' }, { employeeId: e.id }] }, raw: true });
    return B.windowState({ today: (0, lifecycleCore_1.todayStr)(), eligibleDate, windowDays, openWindows: ws.filter((w) => w.kind === 'open'), lifeEvents: ws.filter((w) => w.kind === 'life_event').map((w) => ({ eventDate: w.startDate })) });
}
