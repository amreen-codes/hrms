import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { pslAccrue, pslYearEnd, pslEffective, pslUsableFrom, windowState, PSL_SEED, quarterOf } from '../src/benefitCore';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const today = new Date().toISOString().slice(0, 10), plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let id: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n.toLowerCase()] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api/' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api/' + url).set(as(n));
const ts = (employeeId: number, from: string, to: string, hours: number) => M.Timesheet.create({ employeeId, periodStart: from, periodEnd: to, status: 'approved', regularHours: hours, otHours: 0, dtHours: 0, payrollStatus: 'ready' } as any);

describe('benefitCore engines', () => {
  const ca = PSL_SEED.find((x) => x.jurisdiction === 'CA')!.value, wa = PSL_SEED.find((x) => x.jurisdiction === 'WA')!.value, ny = PSL_SEED.find((x) => x.jurisdiction === 'NY')!.value, dc = PSL_SEED.find((x) => x.jurisdiction === 'DC')!.value;
  it('seeds exactly the 20 states + DC of Appendix A2', () => { expect(PSL_SEED.length).toBe(21); expect(new Set(PSL_SEED.map((x) => x.jurisdiction)).size).toBe(21); expect(PSL_SEED.every((x) => x.value.hoursPerWorked > 0)).toBe(true); });
  it('accrues 1 hour per 30 worked and stops at the annual cap', () => {
    expect(pslAccrue({ rule: ca, employerSize: 20, hoursWorked: 90, accruedThisYear: 0 }).accrued).toBe(3);
    const r = pslAccrue({ rule: ca, employerSize: 20, hoursWorked: 90, accruedThisYear: 79 }); expect([r.accrued, r.capped]).toEqual([1, true]);
    expect(pslAccrue({ rule: wa, employerSize: 20, hoursWorked: 400, accruedThisYear: 500 }).accrued).toBe(10);                 // WA: no annual cap, 1 per 40
  });
  it('uses the employer-size tier and the unpaid threshold', () => {
    expect(pslEffective(ny, 50).accrualCapHours).toBe(40); expect(pslEffective(ny, 150).accrualCapHours).toBe(56);
    expect(pslEffective(dc, 10).hoursPerWorked).toBe(87); expect(pslEffective(dc, 30).hoursPerWorked).toBe(43); expect(pslEffective(dc, 200).hoursPerWorked).toBe(37);
    const ma = PSL_SEED.find((x) => x.jurisdiction === 'MA')!.value; const r = pslAccrue({ rule: ma, employerSize: 5, hoursWorked: 300, accruedThisYear: 0 });
    expect([r.accrued, r.paid]).toEqual([0, false]); expect(r.review[0]).toMatch(/company policy/);
  });
  it('year-end carryover and waiting period', () => {
    expect(pslYearEnd(wa, 55).carry).toBe(40); expect(pslYearEnd(wa, 12).carry).toBe(12); expect(pslYearEnd(ca, 30).review.length).toBe(1);   // CA states no carryover: review
    expect(pslUsableFrom('2026-01-01', 90)).toBe('2026-04-01');
  });
  it('enrollment windows: new hire, open enrollment and life events', () => {
    const base = { today: '2026-06-15', eligibleDate: '2026-06-01', windowDays: 30, openWindows: [], lifeEvents: [] };
    expect(windowState(base)).toMatchObject({ open: true, reason: 'new_hire', closesOn: '2026-07-01' });
    expect(windowState({ ...base, today: '2026-08-01' }).open).toBe(false);
    expect(windowState({ ...base, today: '2026-11-05', openWindows: [{ startDate: '2026-11-01', endDate: '2026-11-30' }] }).reason).toBe('open_enrollment');
    expect(windowState({ ...base, today: '2026-08-10', lifeEvents: [{ eventDate: '2026-08-01' }] })).toMatchObject({ open: true, reason: 'life_event', closesOn: '2026-08-31' });
    expect(windowState({ ...base, today: '2026-09-15', lifeEvents: [{ eventDate: '2026-08-01' }] }).open).toBe(false);
    expect(quarterOf('2026-11-20')).toBe('2026-Q4');
  });
});

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const hana: any = await mk('Hana', 'hr'), hugo: any = await mk('Hugo', 'hr'), mia: any = await mk('Mia', 'manager'), olga: any = await mk('Olga', 'manager');
  const pat: any = await mk('Pat', 'employee', { type: 'part_time', managerId: mia.id, startDate: plus(-800), workState: 'CA', hourlyRate: 20, profile: { hours: 20, city: 'Los Angeles' } });
  const nyc: any = await mk('Nyc', 'employee', { type: 'part_time', managerId: mia.id, startDate: plus(-400), workState: 'NY', profile: { hours: 20, city: 'New York City' } });
  const eli: any = await mk('Eli', 'employee', { managerId: mia.id, startDate: plus(-300), workState: 'WA', hourlyRate: 20, profile: { hours: 40 } }), omar: any = await mk('Omar', 'employee', { startDate: plus(-300), workState: 'TX' });
  id = { hana: hana.id, hugo: hugo.id, mia: mia.id, olga: olga.id, pat: pat.id, nyc: nyc.id, eli: eli.id, omar: omar.id };
  for (const n of ['Hana', 'Hugo', 'Mia', 'Olga', 'Pat', 'Nyc', 'Eli', 'Omar']) tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
});

describe('P19 part-time review', () => {
  it('flags a part-timer who drifts to 30+ hours; only HR reviews; reclassifying is gated and logged', async () => {
    for (let w = 0; w < 52; w++) await ts(id.pat, plus(-7 * (w + 1)), plus(-7 * (w + 1) + 6), 36);          // 36 h a week for a year
    await get('mia', 'part-time/review').expect(403);
    const r = (await get('hana', 'part-time/review').expect(200)).body; const pat = r.rows.find((x: any) => x.employeeId === id.pat);
    expect(pat.aca).toBe(true); expect(pat.reclassify).toBe(true); expect(pat.avgWeekly).toBeGreaterThanOrEqual(35);
    expect(r.rows.find((x: any) => x.employeeId === id.nyc).reclassify).toBe(false);
    await post('hana', `part-time/review/${id.nyc}`, { decision: 'reclassify', note: 'trying it' }).expect(400);   // hours do not reach 30
    await post('hana', `part-time/review/${id.pat}`, { decision: 'maybe', note: 'x' }).expect(400); await post('hana', `part-time/review/${id.pat}`, { decision: 'keep', note: '' }).expect(400);
  });
  it('a quarterly review is recorded once; reclassification changes the type and notifies the employee', async () => {
    await M.Timesheet.destroy({ where: { employeeId: id.pat } }); for (let w = 0; w < 52; w++) await ts(id.pat, plus(-7 * (w + 1)), plus(-7 * (w + 1) + 6), 32);
    expect((await post('hana', `part-time/review/${id.pat}`, { decision: 'reclassify', note: 'Averaging 32 h for a year' }).expect(201)).body.decision).toBe('reclassify');
    expect(((await M.Employee.findByPk(id.pat)) as any).type).toBe('full_time');
    expect(await M.Notification.count({ where: { userId: id.pat, title: 'Your employment classification changed' } })).toBe(1);
    await post('hana', `part-time/review/${id.pat}`, { decision: 'keep', note: 'again' }).expect(404);          // no longer part-time
    await post('hana', `part-time/review/${id.nyc}`, { decision: 'keep', note: 'Hours are steady' }).expect(201);
    await post('hugo', `part-time/review/${id.nyc}`, { decision: 'keep', note: 'twice' }).expect(409);         // once per quarter
    expect((await get('hana', 'part-time/reviews').expect(200)).body.length).toBe(2);
  });
});

describe('P19 schedules with advance notice', () => {
  let sid: number;
  it('flags late notice where predictive scheduling applies and logs every change', async () => {
    const wk = plus(5);
    await post('olga', 'schedules', { employeeId: id.nyc, weekStart: wk, shifts: 'Mon-Fri 9-1' }).expect(403);                  // not Olga's team
    await post('omar', 'schedules', { employeeId: id.nyc, weekStart: wk, shifts: 'x' }).expect(403);
    await post('mia', 'schedules', { employeeId: id.nyc, weekStart: 'soon', shifts: 'x' }).expect(400);
    const r = (await post('mia', 'schedules', { employeeId: id.nyc, weekStart: wk, shifts: 'Mon-Fri 9-1' }).expect(201)).body; sid = r.id;
    expect([r.noticeDays, r.lateNotice]).toEqual([14, true]);                                                                      // New York City: 14 days, only 5 given
    const far = (await post('mia', 'schedules', { employeeId: id.nyc, weekStart: plus(40), shifts: 'Mon-Fri 9-1' }).expect(201)).body; expect(far.lateNotice).toBe(false);
    await post('mia', 'schedules', { employeeId: id.nyc, weekStart: wk, shifts: 'dup' }).expect(409);
    const eliS = (await post('mia', 'schedules', { employeeId: id.eli, weekStart: wk, shifts: 'Mon-Fri 8-4' }).expect(201)).body; expect(eliS.noticeDays).toBe(0);   // no predictive-scheduling rule
    const c = (await post('mia', `schedules/${sid}/change`, { shifts: 'Mon-Fri 10-2', reason: 'Coverage change' }).expect(200)).body;
    expect(c.changeLog.length).toBe(1); expect(c.changeLog[0]).toMatchObject({ reason: 'Coverage change', lateChange: true });
    await post('mia', `schedules/${sid}/change`, { shifts: 'x', reason: '' }).expect(400);
    expect((await get('nyc', 'schedules').expect(200)).body.every((x: any) => x.employeeId === id.nyc)).toBe(true);
    expect((await get('omar', 'schedules').expect(200)).body.length).toBe(0);
  });
});

describe('P16 paid sick leave accrual', () => {
  const ps = plus(-30), pe = plus(-17);
  it('loads Appendix A2 as UNVERIFIED rules (HR only, idempotent)', async () => {
    await post('mia', 'compliance-rules/seed-psl').expect(403);
    const a = (await post('hana', 'compliance-rules/seed-psl').expect(200)).body; expect(a.created).toBe(21);
    expect((await post('hana', 'compliance-rules/seed-psl').expect(200)).body.created).toBe(0);
    const rules = (await get('hana', 'compliance-rules?key=psl').expect(200)).body; expect(rules.every((r: any) => r.verified === false)).toBe(true);
  });
  it('accrues by hours worked per jurisdiction, skips states with no rule, and never double-accrues a period', async () => {
    await M.Timesheet.destroy({ where: { employeeId: { [require('sequelize').Op.in]: [id.pat, id.nyc] } } });                       // clean slate for the accrual period
    await ts(id.eli, ps, pe, 80); await ts(id.pat, ps, pe, 60); await ts(id.omar, ps, pe, 80);
    await M.LeaveBalance.create({ employeeId: id.eli, type: 'Sick', total: 0 } as any);
    await post('mia', 'sick-leave/accrue', { periodStart: ps, periodEnd: pe }).expect(403);
    await post('hana', 'sick-leave/accrue', { periodStart: pe, periodEnd: ps }).expect(400);
    const r = (await post('hana', 'sick-leave/accrue', { periodStart: ps, periodEnd: pe }).expect(200)).body;
    const by = (n: string) => r.accrued.find((x: any) => x.employee === n);
    expect(by('Eli').hours).toBe(2); expect(by('Eli').rule).toBe('WA v1');                                                        // 80 h / 40 (WA)
    expect(by('Pat').hours).toBe(2); expect(by('Pat').verified).toBe(false);                                                      // 60 h / 30 (CA)
    expect(r.noRule).toContain('Omar');                                                                                           // Texas: no state mandate, company policy applies
    expect(((await M.LeaveBalance.findOne({ where: { employeeId: id.eli, type: 'Sick' } })) as any).total).toBe(2);
    const again = (await post('hana', 'sick-leave/accrue', { periodStart: ps, periodEnd: pe }).expect(200)).body; expect(again.alreadyDone).toBeGreaterThanOrEqual(2); expect(again.accrued.length).toBe(0);
    expect(((await M.LeaveBalance.findOne({ where: { employeeId: id.eli, type: 'Sick' } })) as any).total).toBe(2);
    expect((await get('eli', 'sick-leave/ledger').expect(200)).body.every((x: any) => x.employeeId === id.eli)).toBe(true);
  });
  it('enforces the cap across periods and the year-end carryover', async () => {
    await ts(id.eli, plus(-60), plus(-47), 40000);                                                                                // would earn 1000 h: WA has no annual cap
    await post('hana', 'sick-leave/accrue', { periodStart: plus(-60), periodEnd: plus(-47) }).expect(200);
    const b: any = await M.LeaveBalance.findOne({ where: { employeeId: id.eli, type: 'Sick' } }); expect(Number(b.total)).toBe(1002);
    const y = Number(plus(-47).slice(0, 4)); const res = (await post('hana', 'sick-leave/year-end', { year: y }).expect(200)).body;
    expect(res.reset).toBeGreaterThanOrEqual(1); expect(Number(((await M.LeaveBalance.findOne({ where: { employeeId: id.eli, type: 'Sick' } })) as any).total)).toBe(40);   // WA carryover 40
    expect((await post('hana', 'sick-leave/year-end', { year: y }).expect(200)).body.reset).toBe(0);                              // once per year
  });
  it('the waiting period blocks paid sick leave requests until it has passed', async () => {
    await M.Employee.update({ startDate: plus(-10) } as any, { where: { id: id.eli } });
    await post('hana', 'compliance-rules', { key: 'psl', jurisdiction: 'WA', effectiveDate: '2026-02-01', value: { hoursPerWorked: 40, accrualCapHours: null, carryoverHours: 40, waitingDays: 90, minEmployeesPaid: null }, verified: true, legalOwner: 'Counsel' }).expect(201);
    await M.LeaveBalance.update({ total: 40, used: 0, pending: 0 } as any, { where: { employeeId: id.eli, type: 'Sick' } });
    const bad = await post('eli', 'leave', { type: 'Sick', startDate: plus(5), endDate: plus(5), hours: 8 }).expect(400); expect(bad.body.error).toMatch(/waiting period of 90 days/);
    await post('eli', 'leave', { type: 'Sick', startDate: plus(100), endDate: plus(100), hours: 8 }).expect(200);
  });
});

describe('P15 benefit plans, enrollment windows and life events', () => {
  it('HR builds plans from the 60-benefit catalog (validated); employees only see active plans', async () => {
    expect((await get('eli', 'benefits/catalog').expect(200)).body.length).toBe(60);
    const plan = { code: 'gold-medical', name: 'Gold Medical', catalogItem: 'Medical Insurance', employerPct: 75, minHours: 30, waitingDays: 30, windowDays: 30, preTax: true, cost: { employee: 500, spouse: 1000, children: 900, family: 1400 } };
    await post('eli', 'benefit-plans', plan).expect(403);
    await post('hana', 'benefit-plans', { ...plan, catalogItem: 'Free Pizza' }).expect(400); await post('hana', 'benefit-plans', { ...plan, employerPct: 120 }).expect(400);
    await post('hana', 'benefit-plans', { ...plan, cost: { employee: -1, spouse: 1, children: 1, family: 1 } }).expect(400); await post('hana', 'benefit-plans', { ...plan, code: 'Bad Code!' }).expect(400);
    expect((await post('hana', 'benefit-plans', plan).expect(201)).body.code).toBe('gold-medical'); await post('hana', 'benefit-plans', plan).expect(409);
    expect((await get('eli', 'benefits/plans').expect(200)).body.map((p: any) => p.code)).toEqual(['gold-medical']);                  // company plans replace the built-in defaults
  });
  it('enrollment is closed outside a window; open enrollment and life events open it', async () => {
    await M.Employee.update({ startDate: plus(-300) } as any, { where: { id: id.eli } });
    const body = { plan: 'gold-medical', coverage: 'employee', effectiveDate: plus(1) };
    const closed = await post('eli', 'benefits', body).expect(400); expect(closed.body.error).toMatch(/Enrollment is closed/);
    await post('eli', 'enrollment-windows', { startDate: today, endDate: plus(10) }).expect(403);
    await post('hana', 'enrollment-windows', { startDate: today, endDate: plus(90) }).expect(400);                                  // max 60 days
    const w = (await post('hana', 'enrollment-windows', { startDate: today, endDate: plus(10) }).expect(201)).body;
    expect((await post('eli', 'benefits', body).expect(200)).body.status).toBe('active');
    await post('eli', 'benefits', body).expect(400);                                                                                 // already enrolled
    await post('hana', `enrollment-windows/${w.id}/void`).expect(200);
    await post('omar', 'benefits', { plan: 'gold-medical', coverage: 'employee' }).expect(400);                                      // closed again after voiding
  });
  it('a qualifying life event reopens enrollment for that employee only', async () => {
    await post('omar', 'life-events', { event: 'wedding party', eventDate: today }).expect(400);
    await post('omar', 'life-events', { event: 'marriage', eventDate: plus(-60) }).expect(400);                                      // older than 30 days
    const ev = (await post('omar', 'life-events', { event: 'marriage', eventDate: plus(-3) }).expect(201)).body; expect(ev.endDate).toBe(plus(27));
    await post('omar', 'life-events', { event: 'marriage', eventDate: plus(-3) }).expect(409);
    const res = await post('omar', 'benefits', { plan: 'gold-medical', coverage: 'spouse', dependents: [{ name: 'Sam', relation: 'spouse' }], effectiveDate: plus(1) });
    expect([200, 400]).toContain(res.status); if (res.status === 400) expect(res.body.error).not.toMatch(/Enrollment is closed/);   // window is open (any other rule may still apply)
    await post('olga', 'benefits', { plan: 'gold-medical', coverage: 'employee' }).expect(400);                                       // Olga has no window
    expect((await get('omar', 'enrollment-windows').expect(200)).body.some((x: any) => x.kind === 'life_event' && x.employeeId === id.omar)).toBe(true);
    expect((await get('eli', 'enrollment-windows').expect(200)).body.every((x: any) => x.kind === 'open' || x.employeeId === id.eli)).toBe(true);
  });
  it('the hours test counts hours actually worked, so a part-timer who works 30+ hours qualifies', async () => {
    await post('hana', 'benefit-plans', { code: 'dental-30', name: 'Dental 30h', catalogItem: 'Dental Insurance', employerPct: 50, minHours: 30, waitingDays: 0, windowDays: 30, preTax: true, cost: { employee: 38, spouse: 76, children: 82, family: 124 } }).expect(201);
    await post('hana', 'enrollment-windows', { startDate: today, endDate: plus(10) }).expect(201);
    await M.Employee.update({ startDate: plus(-300), type: 'part_time', profile: { hours: 20, city: 'New York City' } } as any, { where: { id: id.nyc } });
    const low = await post('nyc', 'benefits', { plan: 'dental-30', coverage: 'employee' }).expect(400); expect(low.body.error).toMatch(/needs 30\+ hours/);
    for (let w = 0; w < 13; w++) await ts(id.nyc, plus(-7 * (w + 1)), plus(-7 * (w + 1) + 6), 34);
    expect((await post('nyc', 'benefits', { plan: 'dental-30', coverage: 'employee' }).expect(200)).body.status).toBe('active');
  });
});
