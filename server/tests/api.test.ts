import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { run } from '../src/ai';
import { classify, OT_RULES, toHours } from '../src/overtime';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
let ids: Record<string, number> = {}; let tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const login = async (name: string) => (await request(app).post('/api/auth/login').send({ email: `${name.toLowerCase()}@t.test`, password: PW })).body.token as string;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n] });
const att = (employeeId: number, date: string, hours: number, startH = 8) => {
  const ci = new Date(`${date}T${String(startH).padStart(2, '0')}:00:00Z`);
  return M.Attendance.create({ employeeId, date, clockIn: ci, clockOut: new Date(+ci + hours * 36e5), hours, status: 'present' }) as any;
};
const WEEK = { periodStart: '2026-11-02', periodEnd: '2026-11-08' };

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  await mk('Ada', 'admin'); const hr: any = await mk('Hana', 'hr'), mgr: any = await mk('Mia', 'manager'), emp: any = await mk('Eli', 'employee', { managerId: null, hourlyRate: 20 });
  const other: any = await mk('Omar', 'employee', { hourlyRate: 20 }), cal: any = await mk('Cal', 'employee', { workState: 'CA', hourlyRate: 30 });
  await emp.update({ managerId: mgr.id }); await cal.update({ managerId: mgr.id });
  ids = { hr: hr.id, mgr: mgr.id, emp: emp.id, other: other.id, cal: cal.id };
  for (const n of ['Ada', 'Hana', 'Mia', 'Eli', 'Omar', 'Cal']) tok[n.toLowerCase()] = await login(n);
  tok.hana = tok.hana; 
});

describe('security', () => {
  it('requires a token', async () => { await request(app).get('/api/employees').expect(401); });
  it('employee sees only themselves; manager sees team; HR sees all', async () => {
    expect((await request(app).get('/api/employees').set(as('eli')).expect(200)).body.map((e: any) => e.id)).toEqual([ids.emp]);
    expect((await request(app).get('/api/employees').set(as('mia')).expect(200)).body.map((e: any) => e.id).sort()).toEqual([ids.mgr, ids.emp, ids.cal].sort());
    expect((await request(app).get('/api/employees').set(as('hana')).expect(200)).body.length).toBe(6);   // incl. the admin used for payroll approval
  });
  it('never returns password hashes', async () => {
    const r = await request(app).get('/api/employees').set(as('hana')).expect(200);
    const keys = new Set(r.body.flatMap((e: any) => Object.keys(e)));
    for (const k of ['password', 'inviteTokenHash', 'inviteExpiresAt']) expect(keys.has(k)).toBe(false);
  });
  it('employees cannot reach payroll/recruitment/create employee', async () => {
    await request(app).get('/api/payroll').set(as('eli')).expect(403);
    await request(app).get('/api/candidates').set(as('eli')).expect(403);
    await request(app).post('/api/employees').set(as('eli')).send({ name: 'x', email: 'x@x.com' }).expect(403);
  });
  it('locks after 5 bad passwords, then rejects even the right one', async () => {
    await mk('Lock', 'employee');
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email: 'lock@t.test', password: 'wrong-password-1' }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'lock@t.test', password: PW }).expect(423);
  });
  it('a terminated employee loses access immediately', async () => {
    await mk('Gone', 'employee'); const t = await login('Gone');
    await request(app).get('/api/employees').set({ Authorization: 'Bearer ' + t }).expect(200);
    await M.Employee.update({ status: 'terminated' }, { where: { email: 'gone@t.test' } });
    await request(app).get('/api/employees').set({ Authorization: 'Bearer ' + t }).expect(401);
  });
  it('HR creates an employee with a random temp password (no shared default) and short passwords are refused', async () => {
    const r = await request(app).post('/api/employees').set(as('hana')).send({ name: 'New Hire', email: 'new@t.test' }).expect(200);
    expect(r.body.tempPassword.length).toBeGreaterThanOrEqual(10);
    await request(app).post('/api/employees').set(as('hana')).send({ name: 'B', email: 'b@t.test', password: 'short' }).expect(400);
    await request(app).post('/api/employees').set(as('hana')).send({ name: 'Dup', email: 'new@t.test' }).expect(409);
  });
  it('AI tools obey the caller scope', async () => {
    expect(await run('headcount', {}, { id: ids.emp, role: 'employee' })).toEqual({ error: 'Not allowed' });
    expect(await run('pending_leave_requests', {}, { id: ids.emp, role: 'employee' })).toEqual({ error: 'Not allowed' });
    const h: any = await run('headcount', {}, { id: ids.mgr, role: 'manager' }); expect(h.active).toBe(3);   // team only, not the company
  });
});

describe('P2 leave scope', () => {
  let leaveId: number;
  beforeAll(async () => {
    for (const id of [ids.emp, ids.other, ids.mgr]) await M.LeaveBalance.create({ employeeId: id, type: 'Annual', total: 160 });
  });
  it('team manager approves; outsider manager scope and self-approval are refused; double decision blocked', async () => {
    const mine = (await request(app).post('/api/leave').set(as('eli')).send({ type: 'Annual', startDate: '2026-12-01', endDate: '2026-12-01', hours: 8 }).expect(200)).body;
    expect(mine.status).toBe('pending'); leaveId = mine.id;
    const theirs = (await request(app).post('/api/leave').set(as('omar')).send({ type: 'Annual', startDate: '2026-12-01', endDate: '2026-12-01', hours: 8 }).expect(200)).body;
    await request(app).post(`/api/leave/${theirs.id}/decide`).set(as('mia')).send({ approve: true }).expect(403);       // Omar is not Mia's team
    await request(app).post(`/api/leave/${leaveId}/decide`).set(as('eli')).send({ approve: true }).expect(403);
    await request(app).post(`/api/leave/${leaveId}/decide`).set(as('mia')).send({ approve: false }).expect(400);        // comment required
    await request(app).post(`/api/leave/${leaveId}/decide`).set(as('mia')).send({ approve: true }).expect(200);
    await request(app).post(`/api/leave/${leaveId}/decide`).set(as('mia')).send({ approve: true }).expect(400);         // already decided
    const bal: any = await M.LeaveBalance.findOne({ where: { employeeId: ids.emp, type: 'Annual' } });
    expect([bal.pending, bal.used]).toEqual([0, 8]);
    await request(app).post(`/api/leave/${theirs.id}/decide`).set(as('hana')).send({ approve: true }).expect(200);       // HR can
  });
  it('manager cannot approve their own leave; invalid input rejected', async () => {
    const m = (await request(app).post('/api/leave').set(as('mia')).send({ type: 'Annual', startDate: '2026-12-02', endDate: '2026-12-02', hours: 8 }).expect(200)).body;
    await request(app).post(`/api/leave/${m.id}/decide`).set(as('mia')).send({ approve: true }).expect(403);
    await request(app).post('/api/leave').set(as('eli')).send({ type: 'Bogus', startDate: '2026-12-02', endDate: '2026-12-02', hours: 8 }).expect(400);
    await request(app).post('/api/leave').set(as('eli')).send({ type: 'Annual', startDate: '2026-12-05', endDate: '2026-12-02', hours: 8 }).expect(400);
    await request(app).post('/api/leave').set(as('eli')).send({ type: 'Annual', startDate: '2026-12-02', endDate: '2026-12-02', hours: -4 }).expect(400);
  });
});

describe('overtime engine', () => {
  it('federal 45h -> 40/5; CA 13h day -> 8/4/1', () => {
    const fed = classify(['02', '03', '04', '05', '06'].map((d) => ({ workDate: '2026-11-' + d, minutes: 540 })), OT_RULES['*']);
    expect([toHours(fed.regularMin), toHours(fed.otMin)]).toEqual([40, 5]);
    const ca = classify([{ workDate: '2026-11-02', minutes: 780 }], OT_RULES.CA);
    expect([toHours(ca.regularMin), toHours(ca.otMin), toHours(ca.dtMin)]).toEqual([8, 4, 1]);
  });
});

describe('P1 attendance + timesheets', () => {
  let tsId: number;
  it('clock in, break rules, clock out', async () => {
    await request(app).post('/api/attendance/break').set(as('omar')).send({ action: 'start' }).expect(409);
    await request(app).post('/api/attendance/clock').set(as('omar')).expect(200);
    await request(app).post('/api/attendance/break').set(as('omar')).send({ action: 'start' }).expect(200);
    await request(app).post('/api/attendance/break').set(as('omar')).send({ action: 'start' }).expect(409);
    await request(app).post('/api/attendance/clock').set(as('omar')).expect(409);                    // break open
    await request(app).post('/api/attendance/break').set(as('omar')).send({ action: 'end' }).expect(200);
    await request(app).post('/api/attendance/clock').set(as('omar')).expect(200);
    expect((await request(app).get('/api/attendance/status').set(as('omar')).expect(200)).body.clockedIn).toBe(false);
  });
  it('detects missing clock-outs by scope', async () => {
    await M.Attendance.create({ employeeId: ids.other, date: '2026-10-01', clockIn: new Date(Date.now() - 20 * 36e5), status: 'present' });
    expect((await request(app).get('/api/attendance/exceptions').set(as('hana')).expect(200)).body.some((x: any) => x.employeeId === ids.other)).toBe(true);
    expect((await request(app).get('/api/attendance/exceptions').set(as('mia')).expect(200)).body.some((x: any) => x.employeeId === ids.other)).toBe(false);
    await request(app).get('/api/attendance/exceptions').set(as('eli')).expect(403);
    await M.Attendance.destroy({ where: { employeeId: ids.other, clockOut: null } });
  });
  it('submits 45h as 40 regular + 5 OT, blocks duplicates', async () => {
    for (const d of ['02', '03', '04', '05', '06']) await att(ids.emp, `2026-11-${d}`, 9);
    const r = await request(app).post('/api/timesheets').set(as('eli')).send(WEEK).expect(201);
    expect([Number(r.body.regularHours), Number(r.body.otHours)]).toEqual([40, 5]); tsId = r.body.id;
    await request(app).post('/api/timesheets').set(as('eli')).send(WEEK).expect(409);
    await request(app).post('/api/timesheets').set(as('eli')).send({ periodStart: '2026-12-01', periodEnd: '2026-12-07' }).expect(409);  // no hours
  });
  it('blocks submission while a shift is open', async () => {
    const open: any = await M.Attendance.create({ employeeId: ids.other, date: '2026-11-03', clockIn: new Date('2026-11-03T08:00:00Z'), status: 'present' });
    await request(app).post('/api/timesheets').set(as('omar')).send(WEEK).expect(409); await open.destroy();
  });
  it('locks attendance edits while submitted', async () => {
    const a: any = await M.Attendance.findOne({ where: { employeeId: ids.emp, date: '2026-11-03' } });
    await request(app).patch(`/api/attendance/${a.id}`).set(as('eli')).send({ clockIn: '2026-11-03T08:00:00Z', clockOut: '2026-11-03T16:00:00Z', reason: 'fix' }).expect(409);
  });
  it('only the right approver decides; comment required to reject', async () => {
    await request(app).post(`/api/timesheets/${tsId}/decide`).set(as('eli')).send({ approve: true }).expect(403);
    await request(app).post(`/api/timesheets/${tsId}/decide`).set(as('omar')).send({ approve: true }).expect(403);
    await request(app).post(`/api/timesheets/${tsId}/decide`).set(as('mia')).send({ approve: false }).expect(400);
  });
  it('approve -> ready for payroll; duplicate decision refused', async () => {
    const r = await request(app).post(`/api/timesheets/${tsId}/decide`).set(as('mia')).send({ approve: true }).expect(200);
    expect([r.body.status, r.body.payrollStatus]).toEqual(['approved', 'ready']);
    await request(app).post(`/api/timesheets/${tsId}/decide`).set(as('mia')).send({ approve: true }).expect(409);
    await request(app).post(`/api/timesheets/${tsId}/decide`).set(as('mia')).send({ approve: false, comment: 'late' }).expect(409);
    expect(await M.AuditLog.count({ where: { action: 'Timesheet Approved' } })).toBe(1);
  });
  it('reject -> edit -> resubmit as v2', async () => {
    const id = (await att(ids.cal, '2026-11-10', 10)).id;
    const wk = { periodStart: '2026-11-09', periodEnd: '2026-11-15' };
    const s1 = (await request(app).post('/api/timesheets').set(as('cal')).send(wk).expect(201)).body;
    expect([Number(s1.regularHours), Number(s1.otHours), Number(s1.dtHours)]).toEqual([8, 2, 0]);       // California daily OT
    await request(app).post(`/api/timesheets/${s1.id}/decide`).set(as('mia')).send({ approve: false, comment: 'Recheck the long shift' }).expect(200);
    await request(app).patch(`/api/attendance/${id}`).set(as('cal')).send({ clockIn: '2026-11-10T08:00:00Z', clockOut: '2026-11-10T16:00:00Z', reason: 'forgot to clock out' }).expect(200);
    const s2 = (await request(app).post('/api/timesheets').set(as('cal')).send(wk).expect(201)).body;
    expect([s2.id, s2.version, Number(s2.regularHours)]).toEqual([s1.id, 2, 8]);
  });
  it('timesheet lists are scoped', async () => {
    expect((await request(app).get('/api/timesheets').set(as('eli')).expect(200)).body.every((t: any) => t.employeeId === ids.emp)).toBe(true);
    expect((await request(app).get('/api/timesheets').set(as('omar')).expect(200)).body.length).toBe(0);
  });

  describe('P13 corrections', () => {
    let a1: any, a2: any;
    beforeAll(async () => { a1 = await M.Attendance.findOne({ where: { employeeId: ids.emp, date: '2026-11-02' } }); a2 = await M.Attendance.findOne({ where: { employeeId: ids.emp, date: '2026-11-03' } }); });
    const fix = (a: any, day: string, h: number) => ({ attendanceId: a.id, newClockIn: `${day}T08:00:00Z`, newClockOut: `${day}T${String(h).padStart(2, '0')}:00:00Z`, reason: 'Left earlier than recorded' });
    it('not yet exported -> current period, OT recalculated', async () => {
      const c = (await request(app).post(`/api/timesheets/${tsId}/corrections`).set(as('eli')).send(fix(a1, '2026-11-02', 16)).expect(201)).body;
      await request(app).post(`/api/timesheets/${tsId}/corrections`).set(as('eli')).send(fix(a1, '2026-11-02', 15)).expect(409);
      await request(app).post(`/api/corrections/${c.id}/decide`).set(as('eli')).send({ approve: true }).expect(403);
      const d = (await request(app).post(`/api/corrections/${c.id}/decide`).set(as('mia')).send({ approve: true }).expect(200)).body;
      expect([d.appliedTo, Number(d.hoursDelta)]).toEqual(['current_period', -1]);
      const ts: any = await M.Timesheet.findByPk(tsId); expect([Number(ts.regularHours), Number(ts.otHours)]).toEqual([40, 4]);
      await request(app).post(`/api/corrections/${c.id}/decide`).set(as('mia')).send({ approve: true }).expect(409);
    });
    it('payroll: only approved timesheets, benefits deducted, lock + export with hash, timesheet follows', async () => {
      await M.BenefitEnrollment.create({ employeeId: ids.emp, plan: 'dental', coverage: 'employee', monthlyEmployee: 19, monthlyEmployer: 19, status: 'active' });
      await request(app).post('/api/payroll/generate').set(as('eli')).send({ period: '2026-11' }).expect(403);
      const g = (await request(app).post('/api/payroll/generate').set(as('hana')).send({ period: '2026-11' }).expect(200)).body;
      expect(g.sheets).toBe(1);                                                                          // Cal's timesheet (v2, submitted) is excluded
      const sheet: any = await M.PaySheet.findOne({ where: { employeeId: ids.emp } });
      const gross = 40 * 20 + 4 * 20 * 1.5; expect(Number(sheet.gross)).toBe(gross);
      expect(Number(sheet.deductions)).toBe(Math.round((gross * 0.0765 + 19) * 100) / 100);
      await request(app).post('/api/payroll/lock').set(as('hana')).send({ period: '2026-11' }).expect(409);                                // not approved yet
      await request(app).post('/api/payroll/review').set(as('hana')).send({ period: '2026-11' }).expect(200);
      await request(app).post('/api/payroll/approve').set(as('ada')).send({ period: '2026-11' }).expect(200);
      await request(app).post('/api/payroll/lock').set(as('hana')).send({ period: '2026-11' }).expect(200);
      expect((await M.Timesheet.findByPk(tsId) as any).payrollStatus).toBe('locked');
      const ex = await request(app).get('/api/payroll/export?period=2026-11').set(as('hana')).expect(200);
      expect(ex.headers['x-file-sha256']).toMatch(/^[a-f0-9]{64}$/);
      expect((await M.Timesheet.findByPk(tsId) as any).payrollStatus).toBe('exported');
    });
    it('locked/exported period -> correction goes to NEXT period, current figures untouched', async () => {
      const before: any = await M.Timesheet.findByPk(tsId);
      const c = (await request(app).post(`/api/timesheets/${tsId}/corrections`).set(as('eli')).send(fix(a2, '2026-11-03', 16)).expect(201)).body;
      const d = (await request(app).post(`/api/corrections/${c.id}/decide`).set(as('mia')).send({ approve: true }).expect(200)).body;
      expect([d.appliedTo, Number(d.hoursDelta)]).toEqual(['next_period', -1]);
      const after: any = await M.Timesheet.findByPk(tsId); expect([after.regularHours, after.otHours]).toEqual([before.regularHours, before.otHours]);
    });
  });
});
