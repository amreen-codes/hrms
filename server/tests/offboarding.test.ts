import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { finalPay } from '../src/finalPayCore';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const today = new Date().toISOString().slice(0, 10), plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let id: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n.toLowerCase()] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api/' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api/' + url).set(as(n));

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const h1: any = await mk('Hana', 'hr'), h2: any = await mk('Hugo', 'hr'), mia: any = await mk('Mia', 'manager'), olga: any = await mk('Olga', 'manager');
  const eli: any = await mk('Eli', 'employee', { managerId: mia.id, payType: 'hourly', hourlyRate: 20, workState: 'TX' }), tom: any = await mk('Tom', 'employee', { managerId: mia.id }), omar: any = await mk('Omar', 'employee');
  id = { h1: h1.id, h2: h2.id, mia: mia.id, olga: olga.id, eli: eli.id, tom: tom.id, omar: omar.id };
  for (const n of ['Hana', 'Hugo', 'Mia', 'Olga', 'Eli', 'Tom', 'Omar']) tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
});

describe('S6 separation proposals and HR approval', () => {
  let eliOff: number, tomOff: number;
  it('an employee submits a resignation (reason is forced to resignation); nothing starts yet', async () => {
    await post('eli', 'offboarding/propose', { terminationDate: plus(-1) }).expect(400);
    const r = (await post('eli', 'offboarding/propose', { terminationDate: plus(14), reason: 'misconduct', notes: 'moving abroad' }).expect(201)).body; eliOff = r.id;
    expect([r.status, r.reason, r.initiatedBy]).toEqual(['proposed', 'resignation', 'employee']);
    expect(await M.LifecycleTask.count({ where: { employeeId: id.eli, kind: 'offboarding' } })).toBe(0);
    expect((await M.Employee.findByPk(id.eli) as any).status).toBe('active');
    await post('eli', 'offboarding/propose', { terminationDate: plus(20) }).expect(409);                  // one open case only
    expect((await get('eli', 'offboarding/mine').expect(200)).body[0]).toMatchObject({ status: 'proposed' });
  });
  it('a manager proposes only for their own team, with a valid reason code', async () => {
    await post('omar', 'offboarding/propose', { employeeId: id.eli, terminationDate: plus(10), reason: 'layoff' }).expect(403);   // an employee cannot propose for others
    await post('olga', 'offboarding/propose', { employeeId: id.tom, terminationDate: plus(10), reason: 'layoff' }).expect(403);   // not Olga's team
    await post('mia', 'offboarding/propose', { employeeId: id.tom, terminationDate: plus(10), reason: 'fired-lol' }).expect(400);
    await post('mia', 'offboarding/propose', { employeeId: id.eli, terminationDate: plus(10), reason: 'layoff' }).expect(409);   // already open
    const r = (await post('mia', 'offboarding/propose', { employeeId: id.tom, terminationDate: plus(10), reason: 'performance', notes: 'Documented warnings on file' }).expect(201)).body; tomOff = r.id;
    expect([r.status, r.initiatedBy]).toEqual(['proposed', 'manager']);
  });
  it('only HR decides, never on their own case; stopping needs a note; no double decisions', async () => {
    await post('mia', `offboarding/${eliOff}/decide`, { approve: true }).expect(403);
    await post('hana', `offboarding/${eliOff}/decide`, { approve: false }).expect(400);
    const hOff = (await post('hugo', 'offboarding/propose', { terminationDate: plus(30) }).expect(201)).body.id;       // HR resigning
    await post('hugo', `offboarding/${hOff}/decide`, { approve: true }).expect(403);                                    // not their own
    await post('hana', `offboarding/${hOff}/decide`, { approve: false, note: 'Please discuss first' }).expect(200);
    expect((await post('hana', `offboarding/${eliOff}/decide`, { approve: true }).expect(200)).body.status).toBe('in_progress');
    await post('hana', `offboarding/${eliOff}/decide`, { approve: true }).expect(409);
    expect(await M.LifecycleTask.count({ where: { employeeId: id.eli, kind: 'offboarding' } })).toBeGreaterThan(5);
    expect((await get('eli', 'offboarding/mine').expect(200)).body[0].status).toBe('in_progress');
  });
  it('HR can reclassify the reason when approving (audited); managers never see the restricted reason', async () => {
    const r = (await post('hana', `offboarding/${tomOff}/decide`, { approve: true, reason: 'layoff' }).expect(200)).body;
    expect([r.reason, r.originalReason]).toEqual(['layoff', 'performance']);
    expect(await M.AuditLog.count({ where: { action: 'Separation Reclassified' } })).toBe(1);
    await post('hana', `offboarding/${tomOff}/decide`, { approve: true }).expect(409);                                  // already decided
    const list = (await get('mia', 'offboarding').expect(200)).body; expect(list.length).toBe(2); expect(list.every((o: any) => o.reason === undefined)).toBe(true);
    await get('eli', 'offboarding').expect(403);
  });
});

describe('final pay review and S8 compliance rules', () => {
  let offId: number;
  beforeAll(async () => {
    offId = (await M.Offboarding.findOne({ where: { employeeId: id.eli } }) as any).id;
    await M.Timesheet.create({ employeeId: id.eli, periodStart: plus(-14), periodEnd: plus(-8), status: 'approved', regularHours: 40, otHours: 5, dtHours: 0, payrollStatus: 'ready' } as any);
    await M.LeaveBalance.create({ employeeId: id.eli, type: 'Annual', total: 80, used: 8, pending: 0 } as any);
    await M.Bonus.create({ employeeId: id.eli, kind: 'spot', amountCents: 50000, discretionary: false, reason: 'Great work', payPeriod: today.slice(0, 7), proposedBy: id.mia, status: 'approved' } as any);
  });
  it('without a configured state rule everything is flagged for review (no national default)', async () => {
    const r = (await get('hana', `offboarding/${offId}/final-pay`).expect(200)).body;
    expect(r.wagesCents).toBe(40 * 2000 + 5 * 2000 * 1.5); expect(r.leavePayoutCents).toBe(0); expect(r.rule).toBeNull();
    expect(r.needsReview.join(' ')).toMatch(/No final-pay rule/); expect(r.needsReview.join(' ')).toMatch(/bonuses/);
    await get('mia', `offboarding/${offId}/final-pay`).expect(403); await get('eli', `offboarding/${offId}/final-pay`).expect(403);
  });
  it('confirmation needs an explanation while review items remain', async () => {
    await post('hana', `offboarding/${offId}/final-pay/confirm`, {}).expect(400);
    await post('hana', `offboarding/${offId}/final-pay/confirm`, { note: 'short' }).expect(400);
  });
  it('compliance rules: validated, versioned, HR only, effective-dated', async () => {
    const body = { key: 'final_pay', jurisdiction: 'TX', effectiveDate: '2020-01-01', value: { payoutAccruedLeave: true, payoutSick: false, deadline: 'Example deadline text' }, verified: true, sourceUrl: 'https://example.test/law', legalOwner: 'Counsel' };
    await post('mia', 'compliance-rules', body).expect(403);
    await post('hana', 'compliance-rules', { ...body, key: 'Bad Key' }).expect(400); await post('hana', 'compliance-rules', { ...body, jurisdiction: 'Texas' }).expect(400);
    await post('hana', 'compliance-rules', { ...body, value: { payoutAccruedLeave: true } }).expect(400); await post('hana', 'compliance-rules', { ...body, effectiveDate: 'soon' }).expect(400);
    expect((await post('hana', 'compliance-rules', body).expect(201)).body.version).toBe(1);
    expect((await post('hana', 'compliance-rules', { ...body, effectiveDate: plus(400), value: { ...body.value, payoutAccruedLeave: false } }).expect(201)).body.version).toBe(2);
    const now = (await get('hana', 'compliance-rules/effective?key=final_pay&jurisdictions=TX,US').expect(200)).body; expect(now.version).toBe(1);   // v2 starts in the future
    expect((await get('hana', 'compliance-rules?key=final_pay').expect(200)).body.length).toBe(2);
  });
  it('with a verified rule the leave payout is computed; bonuses still need review; confirming completes the task', async () => {
    const r = (await get('hana', `offboarding/${offId}/final-pay`).expect(200)).body;
    expect(r.rule).toMatchObject({ jurisdiction: 'TX', version: 1 }); expect(r.leavePayoutCents).toBe(72 * 2000);
    expect(r.needsReview.join(' ')).not.toMatch(/No final-pay rule/); expect(r.needsReview.join(' ')).toMatch(/bonuses/);
    await post('hana', `offboarding/${offId}/final-pay/confirm`, { note: 'Bonus is discretionary per plan; paid on next cycle' }).expect(200);
    expect(((await M.LifecycleTask.findOne({ where: { employeeId: id.eli, kind: 'offboarding', key: 'final_pay' } })) as any).status).toBe('done');
    expect(await M.AuditLog.count({ where: { action: 'Final Pay Confirmed' } })).toBe(1);
  });
});

describe('finalPay engine', () => {
  const base = { payType: 'hourly', hourlyRateCents: 2000, annualSalaryCents: 0, unpaid: { regularHours: 10, otHours: 0, dtHours: 0 }, leave: { annualHours: 8, sickHours: 4 }, pendingBonusCents: 0, pendingCommissionCents: 0, state: 'TX' };
  it('pays accrued leave only when the rule says so, and flags unverified rules', () => {
    const rule = { payoutAccruedLeave: true, payoutSick: false, deadline: 'x', verified: true };
    expect(finalPay({ ...base, rule }).leavePayoutCents).toBe(8 * 2000); expect(finalPay({ ...base, rule: { ...rule, payoutSick: true } }).leavePayoutCents).toBe(12 * 2000);
    expect(finalPay({ ...base, rule: { ...rule, payoutAccruedLeave: false } }).leavePayoutCents).toBe(0);
    expect(finalPay({ ...base, rule: { ...rule, verified: false } }).needsReview.join()).toMatch(/not been verified/);
    expect(finalPay({ ...base, rule }).needsReview).toEqual([]);
  });
  it('salaried staff are always sent to review instead of guessing a pro-rata', () => {
    const r = finalPay({ ...base, payType: 'salary', annualSalaryCents: 9000000, rule: { payoutAccruedLeave: true, payoutSick: false, deadline: 'x', verified: true } });
    expect(r.wagesCents).toBe(0); expect(r.needsReview.join()).toMatch(/Salaried/);
  });
});
