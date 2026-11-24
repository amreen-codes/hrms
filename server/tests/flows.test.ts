import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { runComplianceJob } from '../src/complianceFlow';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const now = new Date(), today = now.toISOString().slice(0, 10), plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const prev = new Date(now); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1); const PERIOD = prev.toISOString().slice(0, 7);
let id: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n.toLowerCase()] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api/' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api/' + url).set(as(n));

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const ada: any = await mk('Ada', 'admin'), adam: any = await mk('Adam', 'admin'), hana: any = await mk('Hana', 'hr'), mia: any = await mk('Mia', 'manager');
  const eli: any = await mk('Eli', 'employee', { managerId: mia.id, hourlyRate: 20, workState: 'TX', startDate: plus(-60) }), cal: any = await mk('Cal', 'employee', { managerId: mia.id, workState: 'CA', startDate: plus(-2) }), omar: any = await mk('Omar', 'employee', { workState: 'TX', startDate: plus(-2) });
  id = { ada: ada.id, adam: adam.id, hana: hana.id, mia: mia.id, eli: eli.id, cal: cal.id, omar: omar.id };
  for (const n of ['Ada', 'Adam', 'Hana', 'Mia', 'Eli', 'Cal', 'Omar']) tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
});

describe('P4 review, approval, lock, export and unlock with a new version', () => {
  let sheet: number;
  it('sheets are generated from approved timesheets only; Finance can adjust with a reason', async () => {
    await M.Timesheet.create({ employeeId: id.eli, periodStart: `${PERIOD}-01`, periodEnd: `${PERIOD}-07`, status: 'approved', regularHours: 40, otHours: 0, dtHours: 0, payrollStatus: 'ready' } as any);
    await post('hana', 'payroll/generate', { period: PERIOD }).expect(200);
    const sh: any = await M.PaySheet.findOne({ where: { employeeId: id.eli, period: PERIOD } }); sheet = sh.id; expect([Number(sh.gross), sh.status, sh.version]).toEqual([800, 'draft', 1]);
    await post('mia', `payroll/sheets/${sheet}/adjust`, { amount: 50, reason: 'Missed shift premium' }).expect(403);
    await post('hana', `payroll/sheets/${sheet}/adjust`, { amount: 0, reason: 'Missed shift premium' }).expect(400); await post('hana', `payroll/sheets/${sheet}/adjust`, { amount: 50, reason: 'short' }).expect(400);
    const r = (await post('hana', `payroll/sheets/${sheet}/adjust`, { amount: 50, reason: 'Missed shift premium for Nov 3' }).expect(200)).body; expect([Number(r.gross), Number(r.net) > 0]).toEqual([850, true]);
    expect((await get('hana', `payroll/sheets/${sheet}/adjustments`).expect(200)).body[0]).toMatchObject({ reason: 'Missed shift premium for Nov 3' });
    await post('hana', 'payroll/generate', { period: PERIOD }).expect(200); expect(Number(((await M.PaySheet.findByPk(sheet)) as any).gross)).toBe(850);   // adjustments survive regeneration
  });
  it('lock needs approval; only HR reviews; only the Company Admin approves; four-eyes applies', async () => {
    await post('hana', 'payroll/lock', { period: PERIOD }).expect(409);                                                              // draft
    await post('hana', 'payroll/approve', { period: PERIOD }).expect(403); await post('ada', 'payroll/approve', { period: PERIOD }).expect(409);   // hr cannot approve; drafts must be reviewed first
    await post('mia', 'payroll/review', { period: PERIOD }).expect(403); await post('hana', 'payroll/review', { period: PERIOD }).expect(200);
    await post('hana', 'payroll/review', { period: PERIOD }).expect(409);
    await post('hana', `payroll/sheets/${sheet}/adjust`, { amount: -10, reason: 'Correction after review' }).expect(200); expect(((await M.PaySheet.findByPk(sheet)) as any).status).toBe('draft');   // adjusting sends it back
    await post('ada', 'payroll/review', { period: PERIOD }).expect(200);                                                               // an admin reviewed it...
    await post('ada', 'payroll/approve', { period: PERIOD }).expect(403).expect((r) => expect(r.body.error).toMatch(/Four-eyes/));    // ...so the same admin cannot approve it
    await post('adam', 'payroll/reject', { period: PERIOD, reason: 'short' }).expect(400);
    await post('adam', 'payroll/reject', { period: PERIOD, reason: 'Please recheck the Nov 3 premium amount' }).expect(200); expect(((await M.PaySheet.findByPk(sheet)) as any).status).toBe('draft');
    await post('hana', 'payroll/review', { period: PERIOD }).expect(200); await post('adam', 'payroll/approve', { period: PERIOD }).expect(200);
    const a: any = await M.PaySheet.findByPk(sheet); expect([a.status, a.approvedBy]).toEqual(['approved', id.adam]);
    await post('hana', `payroll/sheets/${sheet}/adjust`, { amount: 5, reason: 'Too late to adjust directly' }).expect(409);
  });
  it('locks the approved sheets, exports with a recorded file hash, and unlock is admin-only with a reason (new version)', async () => {
    await post('hana', 'payroll/lock', { period: PERIOD }).expect(200); expect(((await M.Timesheet.findOne({ where: { employeeId: id.eli } })) as any).payrollStatus).toBe('locked');
    await post('hana', 'payroll/unlock', { period: PERIOD, reason: 'Wrong premium amount found' }).expect(403); await post('adam', 'payroll/unlock', { period: PERIOD, reason: 'short' }).expect(400);
    const u = (await post('adam', 'payroll/unlock', { period: PERIOD, reason: 'Wrong premium amount found after lock' }).expect(200)).body; expect(u.newVersion).toBe(2);
    const sh: any = await M.PaySheet.findByPk(sheet); expect([sh.status, sh.version, sh.approvedBy]).toEqual(['draft', 2, null]); expect(((await M.Timesheet.findOne({ where: { employeeId: id.eli } })) as any).payrollStatus).toBe('ready');
    const hist = (await get('hana', `payroll/history?period=${PERIOD}`).expect(200)).body; expect(hist.versions[0]).toMatchObject({ version: 1, unlockReason: 'Wrong premium amount found after lock' });   // the locked version is kept
    await post('hana', 'payroll/review', { period: PERIOD }).expect(200); await post('adam', 'payroll/approve', { period: PERIOD }).expect(200); await post('hana', 'payroll/lock', { period: PERIOD }).expect(200);
    const ex = await request(app).get(`/api/payroll/export?period=${PERIOD}`).set(as('hana')).expect(200); expect(ex.headers['x-file-sha256']).toMatch(/^[a-f0-9]{64}$/);
    const h2 = (await get('hana', `payroll/history`).expect(200)).body; expect([h2.exports[0].period, h2.exports[0].fileHash, h2.exports[0].versionMax]).toEqual([PERIOD, ex.headers['x-file-sha256'], 2]);
    await post('adam', 'payroll/unlock', { period: PERIOD, reason: 'Trying to unlock after the export' }).expect(409);                // already sent to the provider
  });
});

describe('P3 compliance tasks from rules, escalation, waivers and dashboard', () => {
  const rule = (jurisdiction: string, type: string, dueDays: number, extra: any = {}) => ({ key: 'task_handbook', jurisdiction, effectiveDate: '2020-01-01', value: { type, trigger: 'hire', dueDays, retentionYears: 3, ...extra }, verified: true, legalOwner: 'Counsel' });
  it('task rules are validated and set per company and location', async () => {
    await post('hana', 'compliance-rules', rule('US', '', 7)).expect(400); await post('hana', 'compliance-rules', { ...rule('US', 'Handbook', 7), value: { type: 'Handbook', trigger: 'weekly', dueDays: 7 } }).expect(400);
    await post('hana', 'compliance-rules', rule('US', 'Handbook', 0)).expect(400); await post('hana', 'compliance-rules', rule('US', 'Handbook', 7, { retentionYears: 200 })).expect(400);
    await post('hana', 'compliance-rules', rule('US', 'Handbook acknowledgement', 7)).expect(201); await post('hana', 'compliance-rules', rule('CA', 'Handbook acknowledgement', 3)).expect(201);
    await post('hana', 'compliance-rules', { key: 'task_poster', jurisdiction: 'US', effectiveDate: '2020-01-01', value: { type: 'Annual safety poster check', trigger: 'annual', dueDays: 30 } }).expect(201);
  });
  it('tasks are generated per employee with the most specific location rule, once, and the owner is notified', async () => {
    await post('mia', 'compliance/generate').expect(403);
    const created = (await post('hana', 'compliance/generate').expect(200)).body.created; expect(created).toBeGreaterThanOrEqual(8);
    const tasks: any[] = await M.ComplianceTask.findAll({ where: { source: 'rule' }, raw: true });
    const due = (eid: number, type: string) => tasks.find((x) => x.employeeId === eid && x.type === type).dueDate;
    expect(due(id.cal, 'Handbook acknowledgement')).toBe(plus(-2 + 3)); expect(due(id.omar, 'Handbook acknowledgement')).toBe(plus(-2 + 7));   // California rule is stricter
    expect(tasks.find((x) => x.employeeId === id.cal && x.type === 'Handbook acknowledgement').locationKey).toBe('CA');
    expect((await post('hana', 'compliance/generate').expect(200)).body.created).toBe(0);                                               // no duplicates
    expect(await M.Notification.count({ where: { userId: id.cal, title: 'New compliance task' } })).toBeGreaterThanOrEqual(2);
    expect((await get('eli', 'compliance').expect(200)).body.every((x: any) => x.employeeId === id.eli)).toBe(true);
  });
  it('overdue tasks notify owner, manager and HR once, then escalate to the admin after a week', async () => {
    const k: any = await M.ComplianceTask.findOne({ where: { employeeId: id.cal, type: 'Handbook acknowledgement' } });
    await k.update({ dueDate: plus(-1) }); const r = await runComplianceJob(); expect(r.overdue).toBeGreaterThanOrEqual(1); expect((await runComplianceJob()).overdue).toBe(0);
    for (const u of [id.cal, id.mia, id.hana]) expect(await M.Notification.count({ where: { userId: u, title: 'Compliance task overdue', body: { [require('sequelize').Op.like]: 'Cal:%' } } })).toBe(1);   // exactly one for Cal's task
    expect(((await M.ComplianceTask.findByPk(k.id)) as any).status).toBe('overdue'); const esc = (u: number) => M.Notification.count({ where: { userId: u, title: 'Compliance task escalated', body: { [require('sequelize').Op.like]: 'Cal:%' } } });
    expect(await esc(id.ada)).toBe(0);
    await k.update({ dueDate: plus(-9) }); expect((await runComplianceJob()).escalated).toBe(1); expect((await runComplianceJob()).escalated).toBe(0);
    expect(await esc(id.ada)).toBe(1);
  });
  it('dashboard groups open / due soon / overdue by type and location', async () => {
    await post('mia', 'compliance/generate').expect(403); await get('mia', 'compliance/dashboard').expect(403);
    const d = (await get('hana', 'compliance/dashboard').expect(200)).body;
    const ca = d.find((x: any) => x.type === 'Handbook acknowledgement' && x.location === 'CA'); expect(ca.overdue).toBe(1);
    const tx = d.find((x: any) => x.type === 'Handbook acknowledgement' && x.location === 'TX'); expect(tx.open + tx.overdue + tx.done).toBeGreaterThanOrEqual(2);
  });
  it('escalate and waive need notes/reasons, are audited, and never apply to your own task', async () => {
    const k: any = await M.ComplianceTask.findOne({ where: { employeeId: id.omar, type: 'Handbook acknowledgement' } });
    await post('mia', `compliance/${k.id}/escalate`, { note: 'please' }).expect(403); await post('hana', `compliance/${k.id}/escalate`, { note: '' }).expect(400);
    expect((await post('hana', `compliance/${k.id}/escalate`, { note: 'Employee is unreachable' }).expect(200)).body.escalationLevel).toBe(1);
    await post('hana', `compliance/${k.id}/waive`, { reason: 'short' }).expect(400);
    const w = (await post('hana', `compliance/${k.id}/waive`, { reason: 'Contractor exempt from handbook per counsel memo' }).expect(200)).body; expect([w.status, w.waivedBy]).toEqual(['waived', id.hana]);
    await post('hana', `compliance/${k.id}/waive`, { reason: 'Trying to waive it twice over' }).expect(409); await post('hana', `compliance/${k.id}/escalate`, { note: 'already waived' }).expect(409);
    const own: any = await M.ComplianceTask.create({ employeeId: id.hana, type: 'Own task', dueDate: plus(5), status: 'open' } as any);
    await post('hana', `compliance/${own.id}/waive`, { reason: 'I would like to skip my own task' }).expect(403);
    expect(await M.AuditLog.count({ where: { action: 'Compliance Task Waived' } })).toBe(1);
    expect((await get('hana', 'compliance/dashboard').expect(200)).body.find((x: any) => x.type === 'Handbook acknowledgement' && x.location === 'TX').waived).toBe(1);
  });
});

describe('P2 leave notifications and audit', () => {
  it('notifies the manager of a pending request, the employee of an auto-reject and of the decision (with the comment)', async () => {
    await M.LeaveBalance.create({ employeeId: id.cal, type: 'Annual', total: 16 } as any);
    const lr = (await post('cal', 'leave', { type: 'Annual', startDate: plus(20), endDate: plus(20), hours: 8 }).expect(200)).body; expect(lr.status).toBe('pending');
    expect(await M.Notification.count({ where: { userId: id.mia, title: 'Leave request awaiting approval' } })).toBe(1);
    const big = (await post('cal', 'leave', { type: 'Annual', startDate: plus(30), endDate: plus(31), hours: 60 }).expect(200)).body; expect(big.status).toBe('rejected');
    expect(await M.Notification.count({ where: { userId: id.cal, title: 'Leave request rejected automatically' } })).toBe(1);
    await post('mia', `leave/${lr.id}/decide`, { approve: false, comment: 'Team coverage on that day' }).expect(200);
    const n: any = await M.Notification.findOne({ where: { userId: id.cal, title: 'Leave request rejected' } }); expect(n.body).toContain('Team coverage on that day');
    expect(((await M.AuditLog.findOne({ where: { action: 'Leave Request Rejected' } })) as any).detail).toContain('Team coverage on that day');
  });
});
