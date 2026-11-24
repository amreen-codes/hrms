import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { Op } from 'sequelize';
import * as M from './models';
import { log, submitLeave, sickHours, SALARY_FLOOR, sickRule, PLANS, HttpErr, isHR, isStaff, teamOf, scopeIds, inScope, approverCheck } from './services';
import { classify, toHours, otRuleFor } from './overtime';
import { aiRouter } from './ai';
import { reportsRouter } from './reports';
import { wrap, bad, only, staff, hr } from './http';
import { lifecycleRouter, startOnboarding, SENSITIVE_PROFILE_KEYS } from './lifecycle';
import { recruitmentRouter, careersRouter } from './recruitment';
import { compensationRouter, applyDuePayChanges } from './compensation';
import * as P from './payCore';
import { authRouter, auth } from './auth';
import { platformRouter } from './platform';
import { rulesRouter } from './rules';
import { uiInsuranceRouter } from './uiInsurance';
import { complianceFlowRouter } from './complianceFlow';
import { payrollFlowRouter, record as recordExport } from './payrollFlow';
import { trainingRouter } from './training';
import { performanceRouter } from './performance';
import { hrFlowsRouter, sickWaitingError, enrollmentOpen, recentWeekly } from './hrFlows';
import { gate, PlanKey, SubState } from './platformCore';
import { billingRouter } from './billing';
import { createLeave, decideLeave, ping } from './leaveFlow';
import { passwordProblem, assignableRoles, canAssignRole, canResetPassword } from './accountCore';
import { runSystem } from './tenancy';

const r = Router();
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Sequelize cannot LIKE a DATEONLY column reliably: use an explicit month range instead. */
const monthRange = (period: string) => { const [y, m] = period.split('-').map(Number); return { [Op.between]: [`${period}-01`, `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`] }; };
const MAX_FAILED = 5, LOCK_MIN = 15, MISSING_CLOCKOUT_H = 16;

const names = async (ids: number[]) => { const rows: any[] = await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids)] } }, attributes: ['id', 'name'], raw: true }); return new Map(rows.map((x) => [x.id, x.name])); };

// ---------------- auth, sessions (P14): see auth.ts ----------------
r.use(authRouter);
r.use(platformRouter);                                   // Super Admin console (own auth)
r.use(careersRouter);                                    // public careers page + apply (rate limited, no login)
r.use(auth);
r.use(billingRouter);                                    // admin billing: reachable in read-only / past-due so the company can pay
const FEATURE: Record<string, string> = { credentials: 'credentials', candidates: 'recruitment', interviewers: 'recruitment', interviews: 'recruitment', my: 'recruitment', offers: 'recruitment', requisitions: 'recruitment', recruitment: 'recruitment', bonuses: 'compensation', commission: 'compensation', 'pay-changes': 'compensation', sales: 'compensation' };
r.use((q: any, s: Response, n: NextFunction) => {
  M.Company.findByPk(q.user.companyId).then((c: any) => {
    const g = gate({ state: c.subState as SubState, plan: c.plan as PlanKey, feature: FEATURE[String(q.path).split('/')[1]] || 'core', method: q.method });
    if (g.ok === false) return s.status(g.status).json({ error: g.error });
    n();
  }).catch(n);
});
r.use(rulesRouter);
r.use(hrFlowsRouter);
r.use(uiInsuranceRouter);
r.use(payrollFlowRouter);
r.use(complianceFlowRouter);
r.use(trainingRouter);
r.use(performanceRouter);
r.use(lifecycleRouter);
r.use(compensationRouter);                               // P9 / P10 / P17 / P18
r.use(recruitmentRouter);                                // P6 / S1-S3 recruitment                                  // P5 onboarding, P7 credentials, P8 offboarding, notifications

// ---------------- dashboard (scoped) ----------------
r.get('/dashboard', wrap(async (q, s) => {
  const ids = await scopeIds(q.user), me = q.user;
  const rows: any[] = await M.Attendance.findAll({ where: { date: { [Op.gte]: day(-30) }, ...inScope(ids) }, raw: true });
  const byDay: any = {}; rows.forEach((x) => { const e = (byDay[x.date] ||= { date: x.date.slice(5), present: 0, absent: 0, leave: 0 }); e[x.status]++; });
  const empWhere = ids ? { id: { [Op.in]: ids } } : {};
  s.json({
    total: await M.Employee.count({ where: { status: { [Op.ne]: 'terminated' }, ...empWhere } }),
    present: await M.Attendance.count({ where: { date: day(), status: 'present', ...inScope(ids) } }),
    leaves: await M.LeaveRequest.count({ where: { status: 'pending', ...inScope(ids) } }),
    ot: Math.round(rows.reduce((a, x) => a + Math.max(0, Number(x.hours) - 8), 0) * 10) / 10,
    series: Object.keys(byDay).sort().map((k) => byDay[k]),
    activity: isStaff(me) ? await M.AuditLog.findAll({ order: [['id', 'DESC']], limit: 4 }) : [],
    balance: await M.LeaveBalance.findAll({ where: { employeeId: me.id } }),
    events: await M.ComplianceTask.findAll({ where: { status: { [Op.ne]: 'done' }, ...inScope(ids) }, order: [['dueDate', 'ASC']], limit: 3 }),
  });
}));

// ---------------- employees ----------------
r.get('/employees', wrap(async (q, s) => {
  const ids = await scopeIds(q.user);
  s.json(await M.Employee.findAll({ where: ids ? { id: { [Op.in]: ids } } : {}, attributes: { exclude: [...M.SECRET_FIELDS, 'failedAttempts', 'lockedUntil', 'accessRevokedAt', ...(isHR(q.user) ? [] : ['profile']), ...(q.user.role === 'admin' ? [] : ['mustChangePassword'])] }, order: [['id', 'DESC']] }));   // profile (DOB, address, bank last 4) is HR-only
}));
/** Fields a client may never set on an Employee through the create form (role, password, status and security state are decided below). */
const PROTECTED_EMP_FIELDS = ['id', 'companyId', 'role', 'status', 'password', 'confirmPassword', 'failedAttempts', 'lockedUntil', 'accessRevokedAt', 'mustChangePassword', 'passwordChangedAt', 'inviteTokenHash', 'inviteExpiresAt', 'createdAt', 'updatedAt'];
r.post('/employees', hr, wrap(async (q, s) => {
  const b = q.body, pr: any = { ...(b.profile || {}) }, ec = { name: String(pr.ecName || '').trim(), relationship: String(pr.ecRelation || '').trim(), phone: String(pr.ecPhone || '').trim() };
  for (const k of SENSITIVE_PROFILE_KEYS) delete pr[k];   // W-4 / DOB / emergency contact never go into the plain-text profile
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (!name || !email) return s.status(400).json({ error: 'Name and email are required' });
  if (name.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) return s.status(400).json({ error: 'Enter a full name and a valid email address' });
  // Role: Admin may create admin / hr / manager / employee, HR may create manager / employee. `superadmin` is a platform role and can never be assigned here.
  const wanted = b.role === undefined || b.role === '' ? 'employee' : b.role;
  if (!canAssignRole(q.user.role, wanted)) return s.status(403).json({ error: `You are not allowed to create a ${String(wanted).slice(0, 20)} account` });
  const role = wanted;
  // Initial password: set by the creator (typed twice) or, if omitted, a random one shown once. Either way the user must change it at first login.
  if (b.password !== undefined && b.password !== null && b.password !== '') {
    const pwErr = passwordProblem(b.password, email); if (pwErr) return s.status(400).json({ error: pwErr });
    if (b.confirmPassword !== b.password) return s.status(400).json({ error: 'Password and confirm password do not match' });
  }
  // Emails are unique across the whole platform (one login = one account), so check outside the company filter.
  if (await runSystem(() => M.Employee.unscoped().findOne({ where: { email }, attributes: ['id'] }))) return s.status(409).json({ error: 'Email already in use' });
  // P17: exempt roles must meet the higher of federal and state salary floor
  const floor = Math.max(SALARY_FLOOR.US, SALARY_FLOOR[(b.workState || '').toUpperCase()] || 0);
  if (b.flsaExempt && Number(b.annualSalary) < floor) return s.status(400).json({ error: `Exempt salary must be at least $${floor.toLocaleString()} a year in ${b.workState}` });
  const temp = b.password ? null : crypto.randomBytes(9).toString('base64url');          // no shared default password
  const fields: any = Object.fromEntries(Object.entries(b).filter(([k]) => !PROTECTED_EMP_FIELDS.includes(k)));
  const e: any = await M.Employee.create({ ...fields, name, profile: pr, role, email, accessRevokedAt: null, password: bcrypt.hashSync(b.password || temp!, 12), mustChangePassword: true, status: 'onboarding', failedAttempts: 0, lockedUntil: null });
  const ecOk = ec.name.length >= 2 && ec.relationship && /^[0-9+()\-. ]{7,30}$/.test(ec.phone);
  if (ecOk) await M.EmergencyContact.create({ employeeId: e.id, ...ec } as any);
  await startOnboarding(e, q.user.id, ecOk ? ['emergency'] : []);   // P5: checklist from template (I-9, W-4, handbook, emergency contact, HR tasks)
  if (pr.benefits && !pr.benefits.waive) await M.ComplianceTask.create({ employeeId: e.id, type: 'Benefits enrollment documents', dueDate: day(30) });
  for (const [t, h] of [['Annual', 80], ['Sick', sickHours(b.workState)]] as any) await M.LeaveBalance.create({ employeeId: e.id, type: t, total: h });
  await log(q.user.id, 'New Employee Added', `${e.name} (${role})`);
  s.json({ id: e.id, name: e.name, role, mustChangePassword: true, ...(temp ? { tempPassword: temp } : {}) });
}));
/** Admin-only password reset: sets a new initial password, forces a change at next login, ends the person's sessions and clears any lockout. */
r.post('/employees/:id/reset-password', only('admin'), wrap(async (q, s) => {
  const id = Number(q.params.id); if (!Number.isInteger(id)) throw bad('Not found', 404);
  const t: any = await M.Employee.findByPk(id, { attributes: ['id', 'name', 'email', 'role', 'status'] });   // company-scoped: another company's user is a 404
  if (!t) throw bad('Not found', 404);
  if (t.id === q.user.id) throw bad('Use Change password to change your own password', 400);
  if (!canResetPassword(q.user.role, t.role)) throw bad('Not allowed for your role', 403);
  if (t.status === 'invited') throw bad('This person has not accepted their invitation yet', 409);
  const pw = q.body?.password, pwErr = passwordProblem(pw, t.email); if (pwErr) throw bad(pwErr);
  if (q.body?.confirmPassword !== pw) throw bad('Password and confirm password do not match');
  await M.Employee.unscoped().update({ password: bcrypt.hashSync(pw, 12), mustChangePassword: true, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null }, { where: { id: t.id } });
  await runSystem(() => M.Session.update({ revokedAt: new Date() }, { where: { employeeId: t.id, revokedAt: null } }));   // signed out everywhere
  await log(q.user.id, 'Password Reset', `${t.name} (#${t.id})`);
  s.json({ ok: true, mustChangePassword: true });
}));
// Termination now goes through the P8 offboarding workflow (POST /offboarding).
// Global search (header, Ctrl+K): same visibility rules as /employees (employee = self, manager = team, HR = all). Parameterised LIKE, wildcards escaped.
r.get('/search', wrap(async (q, s) => {
  const term = String(q.query.q || '').trim(); if (term.length < 2 || term.length > 60) throw bad('Type 2 to 60 characters');
  const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`, ids = await scopeIds(q.user);
  s.json(await M.Employee.findAll({ where: { [Op.and]: [ids ? { id: { [Op.in]: ids } } : {}, { [Op.or]: ['name', 'email', 'department', 'title'].map((k) => ({ [k]: { [Op.like]: like } })) }] },
    attributes: ['id', 'name', 'department', 'title', 'status'], order: [['name', 'ASC']], limit: 8 }));
}));

// ---------------- P1 attendance: clock, breaks, edits, exceptions ----------------
async function netHours(a: any): Promise<number> {
  const brs: any[] = await M.AttendanceBreak.findAll({ where: { attendanceId: a.id, endAt: { [Op.ne]: null } }, raw: true });
  const brMs = brs.reduce((t, b) => t + (+new Date(b.endAt) - +new Date(b.startAt)), 0);
  return Math.max(0, Math.round(((+new Date(a.clockOut) - +new Date(a.clockIn) - brMs) / 36e5) * 100) / 100);
}
r.post('/attendance/clock', wrap(async (q, s) => {
  const open: any = await M.Attendance.findOne({ where: { employeeId: q.user.id, clockOut: null, clockIn: { [Op.ne]: null } } });
  if (open) {
    if (await M.AttendanceBreak.findOne({ where: { attendanceId: open.id, endAt: null } })) throw bad('End your break before clocking out', 409);
    open.clockOut = new Date(Math.max(Date.now(), +new Date(open.clockIn) + 1000)); open.hours = await netHours(open); await open.save();
    await log(q.user.id, 'Clock Out', `#${open.id}`); return s.json(open);
  }
  const a: any = await M.Attendance.create({ employeeId: q.user.id, date: day(), clockIn: new Date(), status: 'present' });
  await log(q.user.id, 'Clock In', `#${a.id}`); s.json(a);
}));
r.post('/attendance/break', wrap(async (q, s) => {
  const open: any = await M.Attendance.findOne({ where: { employeeId: q.user.id, clockOut: null, clockIn: { [Op.ne]: null } } });
  if (!open) throw bad('You are not clocked in', 409);
  const ob: any = await M.AttendanceBreak.findOne({ where: { attendanceId: open.id, endAt: null } });
  if (q.body.action === 'start') { if (ob) throw bad('A break is already running', 409); await M.AttendanceBreak.create({ attendanceId: open.id, startAt: new Date() }); }
  else if (q.body.action === 'end') { if (!ob) throw bad('There is no open break', 409); await ob.update({ endAt: new Date() }); }
  else throw bad('action must be start or end');
  s.json({ ok: true });
}));
r.get('/attendance/status', wrap(async (q, s) => {
  const open: any = await M.Attendance.findOne({ where: { employeeId: q.user.id, clockOut: null, clockIn: { [Op.ne]: null } } });
  const onBreak = open ? !!(await M.AttendanceBreak.findOne({ where: { attendanceId: open.id, endAt: null } })) : false;
  s.json({ clockedIn: !!open, since: open?.clockIn ?? null, onBreak });
}));
r.get('/attendance/exceptions', staff, wrap(async (q, s) => {   // missing clock-out detection
  const ids = await scopeIds(q.user);
  const rows: any[] = await M.Attendance.findAll({ where: { clockOut: null, clockIn: { [Op.lt]: new Date(Date.now() - MISSING_CLOCKOUT_H * 36e5) }, ...inScope(ids) }, raw: true });
  const nm = await names(rows.map((x) => x.employeeId));
  s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.get('/attendance', wrap(async (q, s) => {
  const ids = await scopeIds(q.user);
  s.json(await M.Attendance.findAll({ where: inScope(ids), order: [['date', 'DESC'], ['id', 'DESC']], limit: 100 }));
}));
// Employee fixes OWN record before the covering timesheet is submitted/approved ("correct and resubmit")
r.patch('/attendance/:id', wrap(async (q, s) => {
  const a: any = await M.Attendance.findOne({ where: { id: q.params.id, employeeId: q.user.id } });
  if (!a) throw bad('Not found', 404);
  const cin = new Date(q.body.clockIn), cout = new Date(q.body.clockOut), reason = String(q.body.reason || '');
  if (isNaN(+cin) || isNaN(+cout) || cout <= cin) throw bad('clockOut must be after clockIn');
  if (reason.length < 3) throw bad('A reason is required');
  const locked = await M.Timesheet.findOne({ where: { employeeId: q.user.id, status: { [Op.in]: ['submitted', 'approved'] }, periodStart: { [Op.lte]: a.date }, periodEnd: { [Op.gte]: a.date } } });
  if (locked) throw bad('This record belongs to a submitted or approved timesheet', 409);
  const old = { clockIn: a.clockIn, clockOut: a.clockOut };
  Object.assign(a, { clockIn: cin, clockOut: cout, date: cin.toISOString().slice(0, 10), status: 'present' }); a.hours = await netHours(a); await a.save();
  await log(q.user.id, 'Attendance Edited', JSON.stringify({ id: a.id, old, new: { clockIn: cin, clockOut: cout }, reason })); s.json(a);
}));

// ---------------- P1 timesheets ----------------
async function totalsFor(emp: any, start: string, end: string) {
  const rows: any[] = await M.Attendance.findAll({ where: { employeeId: emp.id, date: { [Op.between]: [start, end] }, status: 'present' }, raw: true });
  if (rows.some((x) => x.clockIn && !x.clockOut)) throw bad('You still have an open shift in this period. Clock out first.', 409);
  const t = classify(rows.map((x) => ({ workDate: x.date, minutes: Math.round(Number(x.hours) * 60) })), otRuleFor(emp.workState));
  return { regular: toHours(t.regularMin), ot: toHours(t.otMin), dt: toHours(t.dtMin) };
}
r.post('/timesheets', wrap(async (q, s) => {
  const { periodStart: ps, periodEnd: pe } = q.body;
  if (!DATE.test(ps || '') || !DATE.test(pe || '') || pe < ps) throw bad('Choose a valid period');
  if ((Date.parse(pe) - Date.parse(ps)) / 864e5 > 31) throw bad('A period can be at most 31 days');
  const emp: any = await M.Employee.findByPk(q.user.id);
  const tot = await totalsFor(emp, ps, pe);
  if (tot.regular + tot.ot + tot.dt <= 0) throw bad('No worked hours found in this period', 409);
  const clash: any = await M.Timesheet.findOne({ where: { employeeId: emp.id, periodStart: { [Op.lte]: pe }, periodEnd: { [Op.gte]: ps } } });
  let ts: any;
  if (clash) {
    if (clash.status !== 'rejected' || clash.periodStart !== ps) throw bad('A timesheet already exists for this period', 409);
    await clash.update({ periodEnd: pe, status: 'submitted', regularHours: tot.regular, otHours: tot.ot, dtHours: tot.dt, version: clash.version + 1, decidedBy: null, comment: null }); ts = clash;
  } else ts = await M.Timesheet.create({ employeeId: emp.id, periodStart: ps, periodEnd: pe, regularHours: tot.regular, otHours: tot.ot, dtHours: tot.dt });
  await log(q.user.id, ts.version > 1 ? 'Timesheet Resubmitted' : 'Timesheet Submitted', `#${ts.id} v${ts.version} ${ps}..${pe} reg ${tot.regular} ot ${tot.ot} dt ${tot.dt}`);
  s.status(201).json(ts);
}));
r.get('/timesheets', wrap(async (q, s) => {
  const rows: any[] = await M.Timesheet.findAll({ where: inScope(await scopeIds(q.user)), order: [['id', 'DESC']], limit: 200, raw: true });
  const nm = await names(rows.map((x) => x.employeeId));
  s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.post('/timesheets/:id/decide', staff, wrap(async (q, s) => {
  const approve = !!q.body.approve, comment = String(q.body.comment || '').slice(0, 1000);
  if (!approve && !comment) throw bad('A comment is required when rejecting');
  const ts: any = await M.Timesheet.findByPk(q.params.id);
  if (!ts) throw bad('Not found', 404);
  const who = await approverCheck(q.user, ts.employeeId);
  if (who === 'self') throw bad('You cannot approve your own timesheet', 403);
  if (who !== 'ok') throw bad('Not allowed for your role', 403);
  const [n] = await M.Timesheet.update({ status: approve ? 'approved' : 'rejected', payrollStatus: approve ? 'ready' : 'none', decidedBy: q.user.id, comment: comment || null },
    { where: { id: ts.id, status: 'submitted', version: ts.version } });            // conditional update: blocks duplicate decisions
  if (!n) throw bad('This timesheet is no longer waiting for approval', 409);
  await log(q.user.id, approve ? 'Timesheet Approved' : 'Timesheet Rejected', `#${ts.id} ${comment}`);
  s.json(await M.Timesheet.findByPk(ts.id));
}));

// ---------------- P13 corrections after approval ----------------
r.post('/timesheets/:id/corrections', wrap(async (q, s) => {
  const ts: any = await M.Timesheet.findOne({ where: { id: q.params.id, employeeId: q.user.id } });
  if (!ts) throw bad('Not found', 404);
  if (ts.status !== 'approved') throw bad('Corrections can only be requested on approved timesheets', 409);
  const att: any = await M.Attendance.findOne({ where: { id: q.body.attendanceId, employeeId: q.user.id, date: { [Op.between]: [ts.periodStart, ts.periodEnd] }, clockIn: { [Op.ne]: null }, clockOut: { [Op.ne]: null } } });
  if (!att) throw bad('Choose a completed shift from this timesheet');
  const ni = new Date(q.body.newClockIn), no = new Date(q.body.newClockOut), reason = String(q.body.reason || '');
  if (isNaN(+ni) || isNaN(+no) || no <= ni) throw bad('newClockOut must be after newClockIn');
  if (reason.length < 3) throw bad('A reason is required');
  if (await M.TimesheetCorrection.findOne({ where: { attendanceId: att.id, status: 'pending' } })) throw bad('A correction for this shift is already waiting for approval', 409);
  const c: any = await M.TimesheetCorrection.create({ timesheetId: ts.id, employeeId: q.user.id, attendanceId: att.id, oldClockIn: att.clockIn, oldClockOut: att.clockOut, newClockIn: ni, newClockOut: no, reason });
  await log(q.user.id, 'Correction Requested', `#${c.id} ts#${ts.id} ${reason}`); s.status(201).json(c);
}));
r.get('/corrections', wrap(async (q, s) => {
  const rows: any[] = await M.TimesheetCorrection.findAll({ where: inScope(await scopeIds(q.user)), order: [['id', 'DESC']], limit: 200, raw: true });
  const nm = await names(rows.map((x) => x.employeeId)); s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.post('/corrections/:id/decide', staff, wrap(async (q, s) => {
  const approve = !!q.body.approve, comment = String(q.body.comment || '').slice(0, 1000);
  if (!approve && !comment) throw bad('A comment is required when rejecting');
  const c: any = await M.TimesheetCorrection.findByPk(q.params.id);
  if (!c) throw bad('Not found', 404);
  const who = await approverCheck(q.user, c.employeeId);
  if (who === 'self') throw bad('You cannot approve your own correction', 403);
  if (who !== 'ok') throw bad('Not allowed for your role', 403);
  const [n] = await M.TimesheetCorrection.update({ status: approve ? 'approved' : 'rejected', decidedBy: q.user.id, comment: comment || null }, { where: { id: c.id, status: 'pending' } });
  if (!n) throw bad('This correction is no longer pending', 409);
  let appliedTo: string | null = null, delta: number | null = null;
  if (approve) {
    const ts: any = await M.Timesheet.findByPk(c.timesheetId), att: any = await M.Attendance.findByPk(c.attendanceId);
    const hrs = (i: any, o: any) => Math.round(((+new Date(o) - +new Date(i)) / 36e5) * 100) / 100;
    delta = Math.round((hrs(c.newClockIn, c.newClockOut) - hrs(c.oldClockIn, c.oldClockOut)) * 100) / 100;
    // P13 gateway: period locked or exported? yes -> next pay period; no -> recalculate OT and update the current period
    appliedTo = ['locked', 'exported'].includes(ts.payrollStatus) ? 'next_period' : 'current_period';
    if (appliedTo === 'current_period') {
      Object.assign(att, { clockIn: c.newClockIn, clockOut: c.newClockOut, date: new Date(c.newClockIn).toISOString().slice(0, 10) }); att.hours = await netHours(att); await att.save();
      const t = await totalsFor(await M.Employee.findByPk(ts.employeeId), ts.periodStart, ts.periodEnd);
      await ts.update({ regularHours: t.regular, otHours: t.ot, dtHours: t.dt });
    }
    await c.update({ appliedTo, hoursDelta: delta });
  }
  await log(q.user.id, approve ? 'Correction Approved' : 'Correction Rejected', `#${c.id} ${appliedTo ?? ''} ${delta ?? ''} ${comment}`);
  s.json(await M.TimesheetCorrection.findByPk(c.id));
}));

// ---------------- P2 leave ----------------
r.get('/leave', wrap(async (q, s) => {
  const rows: any[] = await M.LeaveRequest.findAll({ where: inScope(await scopeIds(q.user)), order: [['id', 'DESC']], limit: 100, raw: true });
  const nm = await names(rows.map((x) => x.employeeId)); s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.post('/leave', wrap(async (q, s) => s.json(await createLeave(q.user, q.body))));
r.post('/leave/:id/decide', staff, wrap(async (q, s) => s.json(await decideLeave(q.user, q.params.id, !!q.body.approve, q.body.comment))));

// ---------------- P4 payroll: approved timesheets + benefits deductions -> lock -> export ----------------
r.get('/payroll', hr, wrap(async (q, s) => s.json(await M.PaySheet.findAll({ where: q.query.period ? { period: String(q.query.period) } : {}, order: [['id', 'DESC']], limit: 200 }))));
r.post('/payroll/generate', hr, wrap(async (q, s) => {
  const period = String(q.body.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) throw bad('period must look like 2026-11');
  let made = 0; await applyDuePayChanges();
  for (const e of (await M.Employee.findAll({ where: { status: 'active' } })) as any[]) {
    const sheets: any[] = await M.Timesheet.findAll({ where: { employeeId: e.id, status: 'approved', periodStart: monthRange(period) }, raw: true });
    const cl: any = await M.CommissionLine.findOne({ where: { employeeId: e.id, period, status: 'approved' } });
    const bns: any[] = await M.Bonus.findAll({ where: { employeeId: e.id, payPeriod: period, status: 'approved' } });
    const claw: any[] = await M.Bonus.findAll({ where: { employeeId: e.id, status: 'clawed_back', clawbackMethod: 'payroll_deduction', clawbackApplied: false } });
    if (!sheets.length && !cl && !bns.length) continue;                            // only APPROVED timesheets, commission and bonuses reach payroll
    const reg = sheets.reduce((a, x) => a + Number(x.regularHours), 0), ot = sheets.reduce((a, x) => a + Number(x.otHours), 0), dt = sheets.reduce((a, x) => a + Number(x.dtHours), 0);
    const rate = Number(e.hourlyRate);
    const baseGross = e.payType === 'salary' ? Number(e.annualSalary) / 12 : reg * rate + ot * rate * 1.5 + dt * rate * 2;
    const commission = (cl?.payableCents || 0) / 100, bonus = bns.reduce((a, x) => a + x.amountCents, 0) / 100;
    // P10: commission and non-discretionary bonus belong in the OT regular rate for non-exempt staff
    const extras = Math.max(0, cl?.payableCents || 0) + bns.filter((x) => !x.discretionary).reduce((a, x) => a + x.amountCents, 0);
    const otPremium = e.flsaExempt ? 0 : P.otPremiumOnExtras(extras, reg + ot + dt, ot + dt) / 100;
    const gross = baseGross + commission + bonus + otPremium;
    const supplemental = bns.reduce((a, x) => a + x.withholdingCents, 0) / 100, clawDed = claw.reduce((a, x) => a + x.amountCents, 0) / 100;
    const ben: any[] = await M.BenefitEnrollment.findAll({ where: { employeeId: e.id, status: 'active' }, raw: true });
    const benefits = ben.reduce((a, b) => a + Number(b.monthlyEmployee), 0);
    const ded = gross * 0.0765 + benefits + supplemental + clawDed, round = (n: number) => Math.round(n * 100) / 100;
    const [p]: any = await M.PaySheet.findOrCreate({ where: { employeeId: e.id, period } });
    if (p.status !== 'draft') continue;
    const adj = Number(p.adjustment || 0);   // Finance adjustments (with reasons) survive a regeneration
    Object.assign(p, { regularHours: reg, otHours: ot + dt, commission: round(commission), bonus: round(bonus), gross: round(gross + adj), deductions: round(ded), net: round(gross + adj - ded) }); await p.save(); made++;
  }
  await log(q.user.id, 'Payroll Generated', `${period} sheets:${made}`); s.json({ ok: true, sheets: made });
}));
r.post('/payroll/lock', hr, wrap(async (q, s) => {
  const period = String(q.body.period || '');
  const pending = await M.PaySheet.count({ where: { period, status: { [Op.in]: ['draft', 'reviewed'] } } });
  if (pending) throw bad(`${pending} pay sheet(s) are not approved yet: Finance reviews, then the Company Admin approves payroll`, 409);
  const sheets: any[] = await M.PaySheet.findAll({ where: { period, status: 'approved' }, raw: true });
  if (!sheets.length) throw bad('There are no approved pay sheets to lock for this period', 409);
  await M.PaySheet.update({ status: 'locked' }, { where: { period, status: 'approved' } });
  if (sheets.length) await M.Timesheet.update({ payrollStatus: 'locked' }, { where: { employeeId: { [Op.in]: sheets.map((x) => x.employeeId) }, status: 'approved', periodStart: monthRange(period) } });
  if (sheets.length) {
    const ids = sheets.map((x) => x.employeeId), who = { [Op.in]: ids };
    await M.CommissionLine.update({ status: 'locked' } as any, { where: { employeeId: who, period, status: 'approved' } });
    await M.Bonus.update({ status: 'paid', paidAt: day() } as any, { where: { employeeId: who, payPeriod: period, status: 'approved' } });
    await M.Bonus.update({ clawbackApplied: true } as any, { where: { employeeId: who, status: 'clawed_back', clawbackMethod: 'payroll_deduction', clawbackApplied: false } });
  }
  await log(q.user.id, 'Payroll Locked', period); s.json({ ok: true });
}));
const csvCell = (v: any) => { const t = String(v ?? ''); return /^[=+\-@\t\r]/.test(t) ? "'" + t : t; };   // CSV-injection safe
r.get('/payroll/export', hr, wrap(async (q, s) => {
  const period = String(q.query.period || '');
  const rows: any[] = await M.PaySheet.findAll({ where: { period, status: { [Op.ne]: 'draft' } }, raw: true });
  const csv = 'employeeId,period,regularHours,otHours,gross,deductions,net,commission,bonus\n' + rows.map((x) => [x.employeeId, x.period, x.regularHours, x.otHours, x.gross, x.deductions, x.net, x.commission, x.bonus].map(csvCell).join(',')).join('\n');
  const hash = crypto.createHash('sha256').update(csv).digest('hex');
  await M.PaySheet.update({ status: 'exported' }, { where: { period, status: 'locked' } });
  await M.Timesheet.update({ payrollStatus: 'exported' }, { where: { payrollStatus: 'locked', periodStart: monthRange(period) } });
  await recordExport(period, rows.length, hash, q.user.id, Math.max(1, ...rows.map((r) => Number(r.version) || 1)));
  await log(q.user.id, 'Payroll Exported', `${period} sha256:${hash}`);
  s.type('text/csv').set('X-File-SHA256', hash).send(csv);
}));

// ---------------- P3 compliance ----------------
r.get('/compliance', wrap(async (q, s) => {
  await M.ComplianceTask.update({ status: 'overdue' }, { where: { status: 'open', dueDate: { [Op.lt]: day() } } });
  s.json(await M.ComplianceTask.findAll({ where: inScope(await scopeIds(q.user)), order: [['dueDate', 'ASC']], limit: 100 }));
}));
r.post('/compliance/:id/complete', wrap(async (q, s) => {
  const t: any = await M.ComplianceTask.findByPk(q.params.id);
  if (!t) throw bad('Not found', 404);
  if (!isHR(q.user) && t.employeeId !== q.user.id) throw bad('Not allowed for your role', 403);   // owner or HR only
  await t.update({ status: 'done' }); await log(q.user.id, 'Compliance Task Done', `#${t.id}`); s.json({ ok: true });
}));

// P6 recruitment lives in recruitment.ts (requisitions, careers intake, screening, interviews, offers, hire).

// ---------------- P16 sick leave ----------------
r.get('/sick/summary', wrap(async (q, s) => {
  const e: any = await M.Employee.findByPk(q.user.id);
  s.json({ rule: sickRule(e?.workState), startDate: e?.startDate, balance: await M.LeaveBalance.findOne({ where: { employeeId: q.user.id, type: 'Sick' } }),
    requests: await M.LeaveRequest.findAll({ where: { employeeId: q.user.id, type: 'Sick' }, order: [['id', 'DESC']], limit: 20 }) });
}));
r.get('/sick/rule/:state', staff, wrap(async (q, s) => s.json(sickRule(q.params.state))));

// ---------------- P15 benefits (HR sees all; everyone else only their own) ----------------
const planList = async () => { const db: any[] = await M.BenefitPlan.findAll({ where: { active: true }, order: [['name', 'ASC']] }); return db.length ? db.map((p) => p.toJSON()) : PLANS; };
r.get('/benefits/plans', wrap(async (_q, s) => s.json(await planList())));
r.get('/benefits', wrap(async (q, s) => s.json(await M.BenefitEnrollment.findAll({ where: isHR(q.user) ? {} : { employeeId: q.user.id }, order: [['id', 'DESC']], limit: 200 }))));
r.post('/benefits', wrap(async (q, s) => {
  const { plan, coverage, effectiveDate, dependents = [], waive } = q.body;
  const e: any = await M.Employee.findByPk(q.user.id); const pl: any = (await planList()).find((x: any) => x.code === plan);
  if (!pl) return s.status(400).json({ error: 'Choose a plan' });
  if (!waive && !['employee', 'spouse', 'children', 'family'].includes(coverage)) return s.status(400).json({ error: 'Choose a coverage level' });
  if (await M.BenefitEnrollment.findOne({ where: { employeeId: e.id, plan, status: { [Op.in]: ['active', 'pending_docs'] } } })) return s.status(400).json({ error: 'Already enrolled in this plan' });
  // P19 -> P15: the hours test uses the HIGHER of scheduled hours and the rolling 13-week average actually worked (a part-timer who drifts to 30+ hours becomes eligible)
  const hrs = Math.round(Math.max(Number(e.profile?.hours ?? (e.type === 'full_time' ? 40 : 20)), await recentWeekly(e.id)) * 10) / 10;
  const from = new Date(new Date(e.startDate || Date.now()).getTime() + (pl.waitingDays ?? 30) * 864e5).toISOString().slice(0, 10);
  // P15: enrolling or waiving is only possible inside an enrollment window (after hire, open enrollment, or a qualifying life event)
  const win = await enrollmentOpen(e, from, pl.windowDays ?? 30);
  if (!win.open) return s.status(400).json({ error: 'Enrollment is closed. You can enroll after you become eligible, during open enrollment, or within 30 days of a qualifying life event.' });
  if (!waive && hrs < pl.minHours) return s.status(400).json({ error: `${pl.name} needs ${pl.minHours}+ hours a week. You are scheduled ${hrs}.` });
  if (!waive && effectiveDate && effectiveDate < from && day() < from) return s.status(400).json({ error: `Waiting period: benefits can start from ${from}` });
  if (!waive && ['spouse', 'children', 'family'].includes(coverage) && !dependents.length) return s.status(400).json({ error: 'Add at least one dependent for this coverage level' });
  const total = (pl.cost as any)[coverage] || 0;
  const row: any = await M.BenefitEnrollment.create({ employeeId: e.id, plan, coverage: waive ? 'waived' : coverage, effectiveDate: effectiveDate || from, dependents,
    monthlyEmployee: waive ? 0 : total * (1 - pl.employerPct / 100), monthlyEmployer: waive ? 0 : total * pl.employerPct / 100, preTax: pl.preTax,
    status: waive ? 'waived' : dependents.length ? 'pending_docs' : 'active' });
  if (row.status === 'pending_docs') await M.ComplianceTask.create({ employeeId: e.id, type: `Dependent documents: ${pl.name}`, dueDate: day(30) });
  await log(q.user.id, waive ? 'Benefit Waived' : 'Benefit Enrolled', pl.name); s.json(row);
}));
r.post('/benefits/:id/verify', hr, wrap(async (q, s) => {
  const b: any = await M.BenefitEnrollment.findByPk(q.params.id); if (!b || b.status !== 'pending_docs') return s.status(400).json({ error: 'Not waiting for documents' });
  b.status = q.body.valid ? 'active' : 'rejected'; b.comment = q.body.comment || null; await b.save();
  await log(q.user.id, q.body.valid ? 'Dependents Verified' : 'Dependents Rejected', `${b.plan} #${b.id}`); s.json(b);
}));

r.use(aiRouter);
r.use(reportsRouter);
export default r;
