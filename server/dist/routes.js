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
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const overtime_1 = require("./overtime");
const ai_1 = require("./ai");
const reports_1 = require("./reports");
const http_1 = require("./http");
const lifecycle_1 = require("./lifecycle");
const recruitment_1 = require("./recruitment");
const compensation_1 = require("./compensation");
const P = __importStar(require("./payCore"));
const auth_1 = require("./auth");
const platform_1 = require("./platform");
const rules_1 = require("./rules");
const uiInsurance_1 = require("./uiInsurance");
const complianceFlow_1 = require("./complianceFlow");
const payrollFlow_1 = require("./payrollFlow");
const training_1 = require("./training");
const performance_1 = require("./performance");
const hrFlows_1 = require("./hrFlows");
const platformCore_1 = require("./platformCore");
const billing_1 = require("./billing");
const leaveFlow_1 = require("./leaveFlow");
const accountCore_1 = require("./accountCore");
const tenancy_1 = require("./tenancy");
const r = (0, express_1.Router)();
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Sequelize cannot LIKE a DATEONLY column reliably: use an explicit month range instead. */
const monthRange = (period) => { const [y, m] = period.split('-').map(Number); return { [sequelize_1.Op.between]: [`${period}-01`, `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`] }; };
const MAX_FAILED = 5, LOCK_MIN = 15, MISSING_CLOCKOUT_H = 16;
const names = async (ids) => { const rows = await M.Employee.findAll({ where: { id: { [sequelize_1.Op.in]: [...new Set(ids)] } }, attributes: ['id', 'name'], raw: true }); return new Map(rows.map((x) => [x.id, x.name])); };
// ---------------- auth, sessions (P14): see auth.ts ----------------
r.use(auth_1.authRouter);
r.use(platform_1.platformRouter); // Super Admin console (own auth)
r.use(recruitment_1.careersRouter); // public careers page + apply (rate limited, no login)
r.use(auth_1.auth);
r.use(billing_1.billingRouter); // admin billing: reachable in read-only / past-due so the company can pay
const FEATURE = { credentials: 'credentials', candidates: 'recruitment', interviewers: 'recruitment', interviews: 'recruitment', my: 'recruitment', offers: 'recruitment', requisitions: 'recruitment', recruitment: 'recruitment', bonuses: 'compensation', commission: 'compensation', 'pay-changes': 'compensation', sales: 'compensation' };
r.use((q, s, n) => {
    M.Company.findByPk(q.user.companyId).then((c) => {
        const g = (0, platformCore_1.gate)({ state: c.subState, plan: c.plan, feature: FEATURE[String(q.path).split('/')[1]] || 'core', method: q.method });
        if (g.ok === false)
            return s.status(g.status).json({ error: g.error });
        n();
    }).catch(n);
});
r.use(rules_1.rulesRouter);
r.use(hrFlows_1.hrFlowsRouter);
r.use(uiInsurance_1.uiInsuranceRouter);
r.use(payrollFlow_1.payrollFlowRouter);
r.use(complianceFlow_1.complianceFlowRouter);
r.use(training_1.trainingRouter);
r.use(performance_1.performanceRouter);
r.use(lifecycle_1.lifecycleRouter);
r.use(compensation_1.compensationRouter); // P9 / P10 / P17 / P18
r.use(recruitment_1.recruitmentRouter); // P6 / S1-S3 recruitment                                  // P5 onboarding, P7 credentials, P8 offboarding, notifications
// ---------------- dashboard (scoped) ----------------
r.get('/dashboard', (0, http_1.wrap)(async (q, s) => {
    const ids = await (0, services_1.scopeIds)(q.user), me = q.user;
    const rows = await M.Attendance.findAll({ where: { date: { [sequelize_1.Op.gte]: day(-30) }, ...(0, services_1.inScope)(ids) }, raw: true });
    const byDay = {};
    rows.forEach((x) => { const e = (byDay[x.date] ||= { date: x.date.slice(5), present: 0, absent: 0, leave: 0 }); e[x.status]++; });
    const empWhere = ids ? { id: { [sequelize_1.Op.in]: ids } } : {};
    s.json({
        total: await M.Employee.count({ where: { status: { [sequelize_1.Op.ne]: 'terminated' }, ...empWhere } }),
        present: await M.Attendance.count({ where: { date: day(), status: 'present', ...(0, services_1.inScope)(ids) } }),
        leaves: await M.LeaveRequest.count({ where: { status: 'pending', ...(0, services_1.inScope)(ids) } }),
        ot: Math.round(rows.reduce((a, x) => a + Math.max(0, Number(x.hours) - 8), 0) * 10) / 10,
        series: Object.keys(byDay).sort().map((k) => byDay[k]),
        activity: (0, services_1.isStaff)(me) ? await M.AuditLog.findAll({ order: [['id', 'DESC']], limit: 4 }) : [],
        balance: await M.LeaveBalance.findAll({ where: { employeeId: me.id } }),
        events: await M.ComplianceTask.findAll({ where: { status: { [sequelize_1.Op.ne]: 'done' }, ...(0, services_1.inScope)(ids) }, order: [['dueDate', 'ASC']], limit: 3 }),
    });
}));
// ---------------- employees ----------------
r.get('/employees', (0, http_1.wrap)(async (q, s) => {
    const ids = await (0, services_1.scopeIds)(q.user);
    s.json(await M.Employee.findAll({ where: ids ? { id: { [sequelize_1.Op.in]: ids } } : {}, attributes: { exclude: [...M.SECRET_FIELDS, 'failedAttempts', 'lockedUntil', 'accessRevokedAt', ...((0, services_1.isHR)(q.user) ? [] : ['profile']), ...(q.user.role === 'admin' ? [] : ['mustChangePassword'])] }, order: [['id', 'DESC']] })); // profile (DOB, address, bank last 4) is HR-only
}));
/** Fields a client may never set on an Employee through the create form (role, password, status and security state are decided below). */
const PROTECTED_EMP_FIELDS = ['id', 'companyId', 'role', 'status', 'password', 'confirmPassword', 'failedAttempts', 'lockedUntil', 'accessRevokedAt', 'mustChangePassword', 'passwordChangedAt', 'inviteTokenHash', 'inviteExpiresAt', 'createdAt', 'updatedAt'];
r.post('/employees', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const b = q.body, pr = { ...(b.profile || {}) }, ec = { name: String(pr.ecName || '').trim(), relationship: String(pr.ecRelation || '').trim(), phone: String(pr.ecPhone || '').trim() };
    for (const k of lifecycle_1.SENSITIVE_PROFILE_KEYS)
        delete pr[k]; // W-4 / DOB / emergency contact never go into the plain-text profile
    const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
    if (!name || !email)
        return s.status(400).json({ error: 'Name and email are required' });
    if (name.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160)
        return s.status(400).json({ error: 'Enter a full name and a valid email address' });
    // Role: Admin may create admin / hr / manager / employee, HR may create manager / employee. `superadmin` is a platform role and can never be assigned here.
    const wanted = b.role === undefined || b.role === '' ? 'employee' : b.role;
    if (!(0, accountCore_1.canAssignRole)(q.user.role, wanted))
        return s.status(403).json({ error: `You are not allowed to create a ${String(wanted).slice(0, 20)} account` });
    const role = wanted;
    // Initial password: set by the creator (typed twice) or, if omitted, a random one shown once. Either way the user must change it at first login.
    if (b.password !== undefined && b.password !== null && b.password !== '') {
        const pwErr = (0, accountCore_1.passwordProblem)(b.password, email);
        if (pwErr)
            return s.status(400).json({ error: pwErr });
        if (b.confirmPassword !== b.password)
            return s.status(400).json({ error: 'Password and confirm password do not match' });
    }
    // Emails are unique across the whole platform (one login = one account), so check outside the company filter.
    if (await (0, tenancy_1.runSystem)(() => M.Employee.unscoped().findOne({ where: { email }, attributes: ['id'] })))
        return s.status(409).json({ error: 'Email already in use' });
    // P17: exempt roles must meet the higher of federal and state salary floor
    const floor = Math.max(services_1.SALARY_FLOOR.US, services_1.SALARY_FLOOR[(b.workState || '').toUpperCase()] || 0);
    if (b.flsaExempt && Number(b.annualSalary) < floor)
        return s.status(400).json({ error: `Exempt salary must be at least $${floor.toLocaleString()} a year in ${b.workState}` });
    const temp = b.password ? null : node_crypto_1.default.randomBytes(9).toString('base64url'); // no shared default password
    const fields = Object.fromEntries(Object.entries(b).filter(([k]) => !PROTECTED_EMP_FIELDS.includes(k)));
    const e = await M.Employee.create({ ...fields, name, profile: pr, role, email, accessRevokedAt: null, password: bcryptjs_1.default.hashSync(b.password || temp, 12), mustChangePassword: true, status: 'onboarding', failedAttempts: 0, lockedUntil: null });
    const ecOk = ec.name.length >= 2 && ec.relationship && /^[0-9+()\-. ]{7,30}$/.test(ec.phone);
    if (ecOk)
        await M.EmergencyContact.create({ employeeId: e.id, ...ec });
    await (0, lifecycle_1.startOnboarding)(e, q.user.id, ecOk ? ['emergency'] : []); // P5: checklist from template (I-9, W-4, handbook, emergency contact, HR tasks)
    if (pr.benefits && !pr.benefits.waive)
        await M.ComplianceTask.create({ employeeId: e.id, type: 'Benefits enrollment documents', dueDate: day(30) });
    for (const [t, h] of [['Annual', 80], ['Sick', (0, services_1.sickHours)(b.workState)]])
        await M.LeaveBalance.create({ employeeId: e.id, type: t, total: h });
    await (0, services_1.log)(q.user.id, 'New Employee Added', `${e.name} (${role})`);
    s.json({ id: e.id, name: e.name, role, mustChangePassword: true, ...(temp ? { tempPassword: temp } : {}) });
}));
/** Admin-only password reset: sets a new initial password, forces a change at next login, ends the person's sessions and clears any lockout. */
r.post('/employees/:id/reset-password', (0, http_1.only)('admin'), (0, http_1.wrap)(async (q, s) => {
    const id = Number(q.params.id);
    if (!Number.isInteger(id))
        throw (0, http_1.bad)('Not found', 404);
    const t = await M.Employee.findByPk(id, { attributes: ['id', 'name', 'email', 'role', 'status'] }); // company-scoped: another company's user is a 404
    if (!t)
        throw (0, http_1.bad)('Not found', 404);
    if (t.id === q.user.id)
        throw (0, http_1.bad)('Use Change password to change your own password', 400);
    if (!(0, accountCore_1.canResetPassword)(q.user.role, t.role))
        throw (0, http_1.bad)('Not allowed for your role', 403);
    if (t.status === 'invited')
        throw (0, http_1.bad)('This person has not accepted their invitation yet', 409);
    const pw = q.body?.password, pwErr = (0, accountCore_1.passwordProblem)(pw, t.email);
    if (pwErr)
        throw (0, http_1.bad)(pwErr);
    if (q.body?.confirmPassword !== pw)
        throw (0, http_1.bad)('Password and confirm password do not match');
    await M.Employee.unscoped().update({ password: bcryptjs_1.default.hashSync(pw, 12), mustChangePassword: true, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null }, { where: { id: t.id } });
    await (0, tenancy_1.runSystem)(() => M.Session.update({ revokedAt: new Date() }, { where: { employeeId: t.id, revokedAt: null } })); // signed out everywhere
    await (0, services_1.log)(q.user.id, 'Password Reset', `${t.name} (#${t.id})`);
    s.json({ ok: true, mustChangePassword: true });
}));
// Termination now goes through the P8 offboarding workflow (POST /offboarding).
// Global search (header, Ctrl+K): same visibility rules as /employees (employee = self, manager = team, HR = all). Parameterised LIKE, wildcards escaped.
r.get('/search', (0, http_1.wrap)(async (q, s) => {
    const term = String(q.query.q || '').trim();
    if (term.length < 2 || term.length > 60)
        throw (0, http_1.bad)('Type 2 to 60 characters');
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`, ids = await (0, services_1.scopeIds)(q.user);
    s.json(await M.Employee.findAll({ where: { [sequelize_1.Op.and]: [ids ? { id: { [sequelize_1.Op.in]: ids } } : {}, { [sequelize_1.Op.or]: ['name', 'email', 'department', 'title'].map((k) => ({ [k]: { [sequelize_1.Op.like]: like } })) }] },
        attributes: ['id', 'name', 'department', 'title', 'status'], order: [['name', 'ASC']], limit: 8 }));
}));
// ---------------- P1 attendance: clock, breaks, edits, exceptions ----------------
async function netHours(a) {
    const brs = await M.AttendanceBreak.findAll({ where: { attendanceId: a.id, endAt: { [sequelize_1.Op.ne]: null } }, raw: true });
    const brMs = brs.reduce((t, b) => t + (+new Date(b.endAt) - +new Date(b.startAt)), 0);
    return Math.max(0, Math.round(((+new Date(a.clockOut) - +new Date(a.clockIn) - brMs) / 36e5) * 100) / 100);
}
r.post('/attendance/clock', (0, http_1.wrap)(async (q, s) => {
    const open = await M.Attendance.findOne({ where: { employeeId: q.user.id, clockOut: null, clockIn: { [sequelize_1.Op.ne]: null } } });
    if (open) {
        if (await M.AttendanceBreak.findOne({ where: { attendanceId: open.id, endAt: null } }))
            throw (0, http_1.bad)('End your break before clocking out', 409);
        open.clockOut = new Date(Math.max(Date.now(), +new Date(open.clockIn) + 1000));
        open.hours = await netHours(open);
        await open.save();
        await (0, services_1.log)(q.user.id, 'Clock Out', `#${open.id}`);
        return s.json(open);
    }
    const a = await M.Attendance.create({ employeeId: q.user.id, date: day(), clockIn: new Date(), status: 'present' });
    await (0, services_1.log)(q.user.id, 'Clock In', `#${a.id}`);
    s.json(a);
}));
r.post('/attendance/break', (0, http_1.wrap)(async (q, s) => {
    const open = await M.Attendance.findOne({ where: { employeeId: q.user.id, clockOut: null, clockIn: { [sequelize_1.Op.ne]: null } } });
    if (!open)
        throw (0, http_1.bad)('You are not clocked in', 409);
    const ob = await M.AttendanceBreak.findOne({ where: { attendanceId: open.id, endAt: null } });
    if (q.body.action === 'start') {
        if (ob)
            throw (0, http_1.bad)('A break is already running', 409);
        await M.AttendanceBreak.create({ attendanceId: open.id, startAt: new Date() });
    }
    else if (q.body.action === 'end') {
        if (!ob)
            throw (0, http_1.bad)('There is no open break', 409);
        await ob.update({ endAt: new Date() });
    }
    else
        throw (0, http_1.bad)('action must be start or end');
    s.json({ ok: true });
}));
r.get('/attendance/status', (0, http_1.wrap)(async (q, s) => {
    const open = await M.Attendance.findOne({ where: { employeeId: q.user.id, clockOut: null, clockIn: { [sequelize_1.Op.ne]: null } } });
    const onBreak = open ? !!(await M.AttendanceBreak.findOne({ where: { attendanceId: open.id, endAt: null } })) : false;
    s.json({ clockedIn: !!open, since: open?.clockIn ?? null, onBreak });
}));
r.get('/attendance/exceptions', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const ids = await (0, services_1.scopeIds)(q.user);
    const rows = await M.Attendance.findAll({ where: { clockOut: null, clockIn: { [sequelize_1.Op.lt]: new Date(Date.now() - MISSING_CLOCKOUT_H * 36e5) }, ...(0, services_1.inScope)(ids) }, raw: true });
    const nm = await names(rows.map((x) => x.employeeId));
    s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.get('/attendance', (0, http_1.wrap)(async (q, s) => {
    const ids = await (0, services_1.scopeIds)(q.user);
    s.json(await M.Attendance.findAll({ where: (0, services_1.inScope)(ids), order: [['date', 'DESC'], ['id', 'DESC']], limit: 100 }));
}));
// Employee fixes OWN record before the covering timesheet is submitted/approved ("correct and resubmit")
r.patch('/attendance/:id', (0, http_1.wrap)(async (q, s) => {
    const a = await M.Attendance.findOne({ where: { id: q.params.id, employeeId: q.user.id } });
    if (!a)
        throw (0, http_1.bad)('Not found', 404);
    const cin = new Date(q.body.clockIn), cout = new Date(q.body.clockOut), reason = String(q.body.reason || '');
    if (isNaN(+cin) || isNaN(+cout) || cout <= cin)
        throw (0, http_1.bad)('clockOut must be after clockIn');
    if (reason.length < 3)
        throw (0, http_1.bad)('A reason is required');
    const locked = await M.Timesheet.findOne({ where: { employeeId: q.user.id, status: { [sequelize_1.Op.in]: ['submitted', 'approved'] }, periodStart: { [sequelize_1.Op.lte]: a.date }, periodEnd: { [sequelize_1.Op.gte]: a.date } } });
    if (locked)
        throw (0, http_1.bad)('This record belongs to a submitted or approved timesheet', 409);
    const old = { clockIn: a.clockIn, clockOut: a.clockOut };
    Object.assign(a, { clockIn: cin, clockOut: cout, date: cin.toISOString().slice(0, 10), status: 'present' });
    a.hours = await netHours(a);
    await a.save();
    await (0, services_1.log)(q.user.id, 'Attendance Edited', JSON.stringify({ id: a.id, old, new: { clockIn: cin, clockOut: cout }, reason }));
    s.json(a);
}));
// ---------------- P1 timesheets ----------------
async function totalsFor(emp, start, end) {
    const rows = await M.Attendance.findAll({ where: { employeeId: emp.id, date: { [sequelize_1.Op.between]: [start, end] }, status: 'present' }, raw: true });
    if (rows.some((x) => x.clockIn && !x.clockOut))
        throw (0, http_1.bad)('You still have an open shift in this period. Clock out first.', 409);
    const t = (0, overtime_1.classify)(rows.map((x) => ({ workDate: x.date, minutes: Math.round(Number(x.hours) * 60) })), (0, overtime_1.otRuleFor)(emp.workState));
    return { regular: (0, overtime_1.toHours)(t.regularMin), ot: (0, overtime_1.toHours)(t.otMin), dt: (0, overtime_1.toHours)(t.dtMin) };
}
r.post('/timesheets', (0, http_1.wrap)(async (q, s) => {
    const { periodStart: ps, periodEnd: pe } = q.body;
    if (!DATE.test(ps || '') || !DATE.test(pe || '') || pe < ps)
        throw (0, http_1.bad)('Choose a valid period');
    if ((Date.parse(pe) - Date.parse(ps)) / 864e5 > 31)
        throw (0, http_1.bad)('A period can be at most 31 days');
    const emp = await M.Employee.findByPk(q.user.id);
    const tot = await totalsFor(emp, ps, pe);
    if (tot.regular + tot.ot + tot.dt <= 0)
        throw (0, http_1.bad)('No worked hours found in this period', 409);
    const clash = await M.Timesheet.findOne({ where: { employeeId: emp.id, periodStart: { [sequelize_1.Op.lte]: pe }, periodEnd: { [sequelize_1.Op.gte]: ps } } });
    let ts;
    if (clash) {
        if (clash.status !== 'rejected' || clash.periodStart !== ps)
            throw (0, http_1.bad)('A timesheet already exists for this period', 409);
        await clash.update({ periodEnd: pe, status: 'submitted', regularHours: tot.regular, otHours: tot.ot, dtHours: tot.dt, version: clash.version + 1, decidedBy: null, comment: null });
        ts = clash;
    }
    else
        ts = await M.Timesheet.create({ employeeId: emp.id, periodStart: ps, periodEnd: pe, regularHours: tot.regular, otHours: tot.ot, dtHours: tot.dt });
    await (0, services_1.log)(q.user.id, ts.version > 1 ? 'Timesheet Resubmitted' : 'Timesheet Submitted', `#${ts.id} v${ts.version} ${ps}..${pe} reg ${tot.regular} ot ${tot.ot} dt ${tot.dt}`);
    s.status(201).json(ts);
}));
r.get('/timesheets', (0, http_1.wrap)(async (q, s) => {
    const rows = await M.Timesheet.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['id', 'DESC']], limit: 200, raw: true });
    const nm = await names(rows.map((x) => x.employeeId));
    s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.post('/timesheets/:id/decide', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const approve = !!q.body.approve, comment = String(q.body.comment || '').slice(0, 1000);
    if (!approve && !comment)
        throw (0, http_1.bad)('A comment is required when rejecting');
    const ts = await M.Timesheet.findByPk(q.params.id);
    if (!ts)
        throw (0, http_1.bad)('Not found', 404);
    const who = await (0, services_1.approverCheck)(q.user, ts.employeeId);
    if (who === 'self')
        throw (0, http_1.bad)('You cannot approve your own timesheet', 403);
    if (who !== 'ok')
        throw (0, http_1.bad)('Not allowed for your role', 403);
    const [n] = await M.Timesheet.update({ status: approve ? 'approved' : 'rejected', payrollStatus: approve ? 'ready' : 'none', decidedBy: q.user.id, comment: comment || null }, { where: { id: ts.id, status: 'submitted', version: ts.version } }); // conditional update: blocks duplicate decisions
    if (!n)
        throw (0, http_1.bad)('This timesheet is no longer waiting for approval', 409);
    await (0, services_1.log)(q.user.id, approve ? 'Timesheet Approved' : 'Timesheet Rejected', `#${ts.id} ${comment}`);
    s.json(await M.Timesheet.findByPk(ts.id));
}));
// ---------------- P13 corrections after approval ----------------
r.post('/timesheets/:id/corrections', (0, http_1.wrap)(async (q, s) => {
    const ts = await M.Timesheet.findOne({ where: { id: q.params.id, employeeId: q.user.id } });
    if (!ts)
        throw (0, http_1.bad)('Not found', 404);
    if (ts.status !== 'approved')
        throw (0, http_1.bad)('Corrections can only be requested on approved timesheets', 409);
    const att = await M.Attendance.findOne({ where: { id: q.body.attendanceId, employeeId: q.user.id, date: { [sequelize_1.Op.between]: [ts.periodStart, ts.periodEnd] }, clockIn: { [sequelize_1.Op.ne]: null }, clockOut: { [sequelize_1.Op.ne]: null } } });
    if (!att)
        throw (0, http_1.bad)('Choose a completed shift from this timesheet');
    const ni = new Date(q.body.newClockIn), no = new Date(q.body.newClockOut), reason = String(q.body.reason || '');
    if (isNaN(+ni) || isNaN(+no) || no <= ni)
        throw (0, http_1.bad)('newClockOut must be after newClockIn');
    if (reason.length < 3)
        throw (0, http_1.bad)('A reason is required');
    if (await M.TimesheetCorrection.findOne({ where: { attendanceId: att.id, status: 'pending' } }))
        throw (0, http_1.bad)('A correction for this shift is already waiting for approval', 409);
    const c = await M.TimesheetCorrection.create({ timesheetId: ts.id, employeeId: q.user.id, attendanceId: att.id, oldClockIn: att.clockIn, oldClockOut: att.clockOut, newClockIn: ni, newClockOut: no, reason });
    await (0, services_1.log)(q.user.id, 'Correction Requested', `#${c.id} ts#${ts.id} ${reason}`);
    s.status(201).json(c);
}));
r.get('/corrections', (0, http_1.wrap)(async (q, s) => {
    const rows = await M.TimesheetCorrection.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['id', 'DESC']], limit: 200, raw: true });
    const nm = await names(rows.map((x) => x.employeeId));
    s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.post('/corrections/:id/decide', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const approve = !!q.body.approve, comment = String(q.body.comment || '').slice(0, 1000);
    if (!approve && !comment)
        throw (0, http_1.bad)('A comment is required when rejecting');
    const c = await M.TimesheetCorrection.findByPk(q.params.id);
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    const who = await (0, services_1.approverCheck)(q.user, c.employeeId);
    if (who === 'self')
        throw (0, http_1.bad)('You cannot approve your own correction', 403);
    if (who !== 'ok')
        throw (0, http_1.bad)('Not allowed for your role', 403);
    const [n] = await M.TimesheetCorrection.update({ status: approve ? 'approved' : 'rejected', decidedBy: q.user.id, comment: comment || null }, { where: { id: c.id, status: 'pending' } });
    if (!n)
        throw (0, http_1.bad)('This correction is no longer pending', 409);
    let appliedTo = null, delta = null;
    if (approve) {
        const ts = await M.Timesheet.findByPk(c.timesheetId), att = await M.Attendance.findByPk(c.attendanceId);
        const hrs = (i, o) => Math.round(((+new Date(o) - +new Date(i)) / 36e5) * 100) / 100;
        delta = Math.round((hrs(c.newClockIn, c.newClockOut) - hrs(c.oldClockIn, c.oldClockOut)) * 100) / 100;
        // P13 gateway: period locked or exported? yes -> next pay period; no -> recalculate OT and update the current period
        appliedTo = ['locked', 'exported'].includes(ts.payrollStatus) ? 'next_period' : 'current_period';
        if (appliedTo === 'current_period') {
            Object.assign(att, { clockIn: c.newClockIn, clockOut: c.newClockOut, date: new Date(c.newClockIn).toISOString().slice(0, 10) });
            att.hours = await netHours(att);
            await att.save();
            const t = await totalsFor(await M.Employee.findByPk(ts.employeeId), ts.periodStart, ts.periodEnd);
            await ts.update({ regularHours: t.regular, otHours: t.ot, dtHours: t.dt });
        }
        await c.update({ appliedTo, hoursDelta: delta });
    }
    await (0, services_1.log)(q.user.id, approve ? 'Correction Approved' : 'Correction Rejected', `#${c.id} ${appliedTo ?? ''} ${delta ?? ''} ${comment}`);
    s.json(await M.TimesheetCorrection.findByPk(c.id));
}));
// ---------------- P2 leave ----------------
r.get('/leave', (0, http_1.wrap)(async (q, s) => {
    const rows = await M.LeaveRequest.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['id', 'DESC']], limit: 100, raw: true });
    const nm = await names(rows.map((x) => x.employeeId));
    s.json(rows.map((x) => ({ ...x, employeeName: nm.get(x.employeeId) })));
}));
r.post('/leave', (0, http_1.wrap)(async (q, s) => s.json(await (0, leaveFlow_1.createLeave)(q.user, q.body))));
r.post('/leave/:id/decide', http_1.staff, (0, http_1.wrap)(async (q, s) => s.json(await (0, leaveFlow_1.decideLeave)(q.user, q.params.id, !!q.body.approve, q.body.comment))));
// ---------------- P4 payroll: approved timesheets + benefits deductions -> lock -> export ----------------
r.get('/payroll', http_1.hr, (0, http_1.wrap)(async (q, s) => s.json(await M.PaySheet.findAll({ where: q.query.period ? { period: String(q.query.period) } : {}, order: [['id', 'DESC']], limit: 200 }))));
r.post('/payroll/generate', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const period = String(q.body.period || '');
    if (!/^\d{4}-\d{2}$/.test(period))
        throw (0, http_1.bad)('period must look like 2026-11');
    let made = 0;
    await (0, compensation_1.applyDuePayChanges)();
    for (const e of (await M.Employee.findAll({ where: { status: 'active' } }))) {
        const sheets = await M.Timesheet.findAll({ where: { employeeId: e.id, status: 'approved', periodStart: monthRange(period) }, raw: true });
        const cl = await M.CommissionLine.findOne({ where: { employeeId: e.id, period, status: 'approved' } });
        const bns = await M.Bonus.findAll({ where: { employeeId: e.id, payPeriod: period, status: 'approved' } });
        const claw = await M.Bonus.findAll({ where: { employeeId: e.id, status: 'clawed_back', clawbackMethod: 'payroll_deduction', clawbackApplied: false } });
        if (!sheets.length && !cl && !bns.length)
            continue; // only APPROVED timesheets, commission and bonuses reach payroll
        const reg = sheets.reduce((a, x) => a + Number(x.regularHours), 0), ot = sheets.reduce((a, x) => a + Number(x.otHours), 0), dt = sheets.reduce((a, x) => a + Number(x.dtHours), 0);
        const rate = Number(e.hourlyRate);
        const baseGross = e.payType === 'salary' ? Number(e.annualSalary) / 12 : reg * rate + ot * rate * 1.5 + dt * rate * 2;
        const commission = (cl?.payableCents || 0) / 100, bonus = bns.reduce((a, x) => a + x.amountCents, 0) / 100;
        // P10: commission and non-discretionary bonus belong in the OT regular rate for non-exempt staff
        const extras = Math.max(0, cl?.payableCents || 0) + bns.filter((x) => !x.discretionary).reduce((a, x) => a + x.amountCents, 0);
        const otPremium = e.flsaExempt ? 0 : P.otPremiumOnExtras(extras, reg + ot + dt, ot + dt) / 100;
        const gross = baseGross + commission + bonus + otPremium;
        const supplemental = bns.reduce((a, x) => a + x.withholdingCents, 0) / 100, clawDed = claw.reduce((a, x) => a + x.amountCents, 0) / 100;
        const ben = await M.BenefitEnrollment.findAll({ where: { employeeId: e.id, status: 'active' }, raw: true });
        const benefits = ben.reduce((a, b) => a + Number(b.monthlyEmployee), 0);
        const ded = gross * 0.0765 + benefits + supplemental + clawDed, round = (n) => Math.round(n * 100) / 100;
        const [p] = await M.PaySheet.findOrCreate({ where: { employeeId: e.id, period } });
        if (p.status !== 'draft')
            continue;
        const adj = Number(p.adjustment || 0); // Finance adjustments (with reasons) survive a regeneration
        Object.assign(p, { regularHours: reg, otHours: ot + dt, commission: round(commission), bonus: round(bonus), gross: round(gross + adj), deductions: round(ded), net: round(gross + adj - ded) });
        await p.save();
        made++;
    }
    await (0, services_1.log)(q.user.id, 'Payroll Generated', `${period} sheets:${made}`);
    s.json({ ok: true, sheets: made });
}));
r.post('/payroll/lock', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const period = String(q.body.period || '');
    const pending = await M.PaySheet.count({ where: { period, status: { [sequelize_1.Op.in]: ['draft', 'reviewed'] } } });
    if (pending)
        throw (0, http_1.bad)(`${pending} pay sheet(s) are not approved yet: Finance reviews, then the Company Admin approves payroll`, 409);
    const sheets = await M.PaySheet.findAll({ where: { period, status: 'approved' }, raw: true });
    if (!sheets.length)
        throw (0, http_1.bad)('There are no approved pay sheets to lock for this period', 409);
    await M.PaySheet.update({ status: 'locked' }, { where: { period, status: 'approved' } });
    if (sheets.length)
        await M.Timesheet.update({ payrollStatus: 'locked' }, { where: { employeeId: { [sequelize_1.Op.in]: sheets.map((x) => x.employeeId) }, status: 'approved', periodStart: monthRange(period) } });
    if (sheets.length) {
        const ids = sheets.map((x) => x.employeeId), who = { [sequelize_1.Op.in]: ids };
        await M.CommissionLine.update({ status: 'locked' }, { where: { employeeId: who, period, status: 'approved' } });
        await M.Bonus.update({ status: 'paid', paidAt: day() }, { where: { employeeId: who, payPeriod: period, status: 'approved' } });
        await M.Bonus.update({ clawbackApplied: true }, { where: { employeeId: who, status: 'clawed_back', clawbackMethod: 'payroll_deduction', clawbackApplied: false } });
    }
    await (0, services_1.log)(q.user.id, 'Payroll Locked', period);
    s.json({ ok: true });
}));
const csvCell = (v) => { const t = String(v ?? ''); return /^[=+\-@\t\r]/.test(t) ? "'" + t : t; }; // CSV-injection safe
r.get('/payroll/export', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const period = String(q.query.period || '');
    const rows = await M.PaySheet.findAll({ where: { period, status: { [sequelize_1.Op.ne]: 'draft' } }, raw: true });
    const csv = 'employeeId,period,regularHours,otHours,gross,deductions,net,commission,bonus\n' + rows.map((x) => [x.employeeId, x.period, x.regularHours, x.otHours, x.gross, x.deductions, x.net, x.commission, x.bonus].map(csvCell).join(',')).join('\n');
    const hash = node_crypto_1.default.createHash('sha256').update(csv).digest('hex');
    await M.PaySheet.update({ status: 'exported' }, { where: { period, status: 'locked' } });
    await M.Timesheet.update({ payrollStatus: 'exported' }, { where: { payrollStatus: 'locked', periodStart: monthRange(period) } });
    await (0, payrollFlow_1.record)(period, rows.length, hash, q.user.id, Math.max(1, ...rows.map((r) => Number(r.version) || 1)));
    await (0, services_1.log)(q.user.id, 'Payroll Exported', `${period} sha256:${hash}`);
    s.type('text/csv').set('X-File-SHA256', hash).send(csv);
}));
// ---------------- P3 compliance ----------------
r.get('/compliance', (0, http_1.wrap)(async (q, s) => {
    await M.ComplianceTask.update({ status: 'overdue' }, { where: { status: 'open', dueDate: { [sequelize_1.Op.lt]: day() } } });
    s.json(await M.ComplianceTask.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['dueDate', 'ASC']], limit: 100 }));
}));
r.post('/compliance/:id/complete', (0, http_1.wrap)(async (q, s) => {
    const t = await M.ComplianceTask.findByPk(q.params.id);
    if (!t)
        throw (0, http_1.bad)('Not found', 404);
    if (!(0, services_1.isHR)(q.user) && t.employeeId !== q.user.id)
        throw (0, http_1.bad)('Not allowed for your role', 403); // owner or HR only
    await t.update({ status: 'done' });
    await (0, services_1.log)(q.user.id, 'Compliance Task Done', `#${t.id}`);
    s.json({ ok: true });
}));
// P6 recruitment lives in recruitment.ts (requisitions, careers intake, screening, interviews, offers, hire).
// ---------------- P16 sick leave ----------------
r.get('/sick/summary', (0, http_1.wrap)(async (q, s) => {
    const e = await M.Employee.findByPk(q.user.id);
    s.json({ rule: (0, services_1.sickRule)(e?.workState), startDate: e?.startDate, balance: await M.LeaveBalance.findOne({ where: { employeeId: q.user.id, type: 'Sick' } }),
        requests: await M.LeaveRequest.findAll({ where: { employeeId: q.user.id, type: 'Sick' }, order: [['id', 'DESC']], limit: 20 }) });
}));
r.get('/sick/rule/:state', http_1.staff, (0, http_1.wrap)(async (q, s) => s.json((0, services_1.sickRule)(q.params.state))));
// ---------------- P15 benefits (HR sees all; everyone else only their own) ----------------
const planList = async () => { const db = await M.BenefitPlan.findAll({ where: { active: true }, order: [['name', 'ASC']] }); return db.length ? db.map((p) => p.toJSON()) : services_1.PLANS; };
r.get('/benefits/plans', (0, http_1.wrap)(async (_q, s) => s.json(await planList())));
r.get('/benefits', (0, http_1.wrap)(async (q, s) => s.json(await M.BenefitEnrollment.findAll({ where: (0, services_1.isHR)(q.user) ? {} : { employeeId: q.user.id }, order: [['id', 'DESC']], limit: 200 }))));
r.post('/benefits', (0, http_1.wrap)(async (q, s) => {
    const { plan, coverage, effectiveDate, dependents = [], waive } = q.body;
    const e = await M.Employee.findByPk(q.user.id);
    const pl = (await planList()).find((x) => x.code === plan);
    if (!pl)
        return s.status(400).json({ error: 'Choose a plan' });
    if (!waive && !['employee', 'spouse', 'children', 'family'].includes(coverage))
        return s.status(400).json({ error: 'Choose a coverage level' });
    if (await M.BenefitEnrollment.findOne({ where: { employeeId: e.id, plan, status: { [sequelize_1.Op.in]: ['active', 'pending_docs'] } } }))
        return s.status(400).json({ error: 'Already enrolled in this plan' });
    // P19 -> P15: the hours test uses the HIGHER of scheduled hours and the rolling 13-week average actually worked (a part-timer who drifts to 30+ hours becomes eligible)
    const hrs = Math.round(Math.max(Number(e.profile?.hours ?? (e.type === 'full_time' ? 40 : 20)), await (0, hrFlows_1.recentWeekly)(e.id)) * 10) / 10;
    const from = new Date(new Date(e.startDate || Date.now()).getTime() + (pl.waitingDays ?? 30) * 864e5).toISOString().slice(0, 10);
    // P15: enrolling or waiving is only possible inside an enrollment window (after hire, open enrollment, or a qualifying life event)
    const win = await (0, hrFlows_1.enrollmentOpen)(e, from, pl.windowDays ?? 30);
    if (!win.open)
        return s.status(400).json({ error: 'Enrollment is closed. You can enroll after you become eligible, during open enrollment, or within 30 days of a qualifying life event.' });
    if (!waive && hrs < pl.minHours)
        return s.status(400).json({ error: `${pl.name} needs ${pl.minHours}+ hours a week. You are scheduled ${hrs}.` });
    if (!waive && effectiveDate && effectiveDate < from && day() < from)
        return s.status(400).json({ error: `Waiting period: benefits can start from ${from}` });
    if (!waive && ['spouse', 'children', 'family'].includes(coverage) && !dependents.length)
        return s.status(400).json({ error: 'Add at least one dependent for this coverage level' });
    const total = pl.cost[coverage] || 0;
    const row = await M.BenefitEnrollment.create({ employeeId: e.id, plan, coverage: waive ? 'waived' : coverage, effectiveDate: effectiveDate || from, dependents,
        monthlyEmployee: waive ? 0 : total * (1 - pl.employerPct / 100), monthlyEmployer: waive ? 0 : total * pl.employerPct / 100, preTax: pl.preTax,
        status: waive ? 'waived' : dependents.length ? 'pending_docs' : 'active' });
    if (row.status === 'pending_docs')
        await M.ComplianceTask.create({ employeeId: e.id, type: `Dependent documents: ${pl.name}`, dueDate: day(30) });
    await (0, services_1.log)(q.user.id, waive ? 'Benefit Waived' : 'Benefit Enrolled', pl.name);
    s.json(row);
}));
r.post('/benefits/:id/verify', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const b = await M.BenefitEnrollment.findByPk(q.params.id);
    if (!b || b.status !== 'pending_docs')
        return s.status(400).json({ error: 'Not waiting for documents' });
    b.status = q.body.valid ? 'active' : 'rejected';
    b.comment = q.body.comment || null;
    await b.save();
    await (0, services_1.log)(q.user.id, q.body.valid ? 'Dependents Verified' : 'Dependents Rejected', `${b.plan} #${b.id}`);
    s.json(b);
}));
r.use(ai_1.aiRouter);
r.use(reports_1.reportsRouter);
exports.default = r;
