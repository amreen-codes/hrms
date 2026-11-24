import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { runUiJob, runInsuranceJob } from '../src/uiInsurance';
import { runAs } from '../src/tenancy';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const today = new Date().toISOString().slice(0, 10), plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let id: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n.toLowerCase()] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api/' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api/' + url).set(as(n));

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const hana: any = await mk('Hana', 'hr'), mia: any = await mk('Mia', 'manager'), eli: any = await mk('Eli', 'employee', { managerId: mia.id, workState: 'CA' }), tom: any = await mk('Tom', 'employee', { managerId: mia.id, workState: 'TX' }), omar: any = await mk('Omar', 'employee', { workState: 'TX' });
  id = { hana: hana.id, mia: mia.id, eli: eli.id, tom: tom.id, omar: omar.id };
  for (const n of ['Hana', 'Mia', 'Eli', 'Tom', 'Omar']) tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
  await M.Offboarding.create({ employeeId: id.eli, terminationDate: plus(-3), reason: 'layoff', originalReason: 'layoff', status: 'complete', initiatedBy: 'hr', startedBy: id.hana } as any);
  await M.Offboarding.create({ employeeId: id.tom, terminationDate: plus(-3), reason: 'performance', originalReason: 'performance', status: 'complete', initiatedBy: 'hr', startedBy: id.hana } as any);
});

describe('P20/P21/S7 unemployment claims', () => {
  let cid: number, tomClaim: number;
  it('only HR; needs a recorded separation, a valid true reason and an explanation when it differs from the separation record', async () => {
    await get('mia', 'ui-claims').expect(403); await get('eli', 'ui-claims').expect(403);
    await post('hana', 'ui-claims', { employeeId: id.omar, uiReason: 'layoff' }).expect(400);                                  // no offboarding record
    await post('hana', 'ui-claims', { employeeId: id.eli, uiReason: 'laid-off-lol' }).expect(400);
    await post('hana', 'ui-claims', { employeeId: id.eli, uiReason: 'misconduct' }).expect(400);                               // separation says layoff: explain
    await post('hana', 'ui-claims', { employeeId: id.eli, uiReason: 'misconduct', reasonNote: 'Incident report filed after the layoff notice' }).expect(201).then(async (r) => { await M.UiClaim.destroy({ where: { id: r.body.id } }); });
    const r = (await post('hana', 'ui-claims', { employeeId: id.eli, uiReason: 'layoff', claimFiledDate: plus(-1) }).expect(201)).body; cid = r.id;
    expect([r.state, r.status, r.responseStatus]).toEqual(['CA', 'open', 'not_requested']);
    expect(r.guidance).toMatchObject({ indicator: 'usually_eligible', whoseCause: 'employer' }); expect(r.guidance.notice).toMatch(/state UI agency decides/i);
    await post('hana', 'ui-claims', { employeeId: id.eli, uiReason: 'layoff' }).expect(409);                                   // one open claim per employee
    tomClaim = (await post('hana', 'ui-claims', { employeeId: id.tom, uiReason: 'performance' }).expect(201)).body.id;
  });
  it('the agency notice sets the response deadline (10 days unless the notice says otherwise)', async () => {
    await post('hana', `ui-claims/${cid}/notice`, { noticeDate: 'tomorrow' }).expect(400); await post('hana', `ui-claims/${cid}/notice`, { noticeDate: today, responseDays: 365 }).expect(400);
    const r = (await post('hana', `ui-claims/${cid}/notice`, { noticeDate: today, agencyClaimId: 'CA-123' }).expect(200)).body;
    expect([r.responseStatus, r.status, r.responseDue, r.daysToResponse]).toEqual(['pending', 'response_due', plus(10), 10]);
    await post('hana', `ui-claims/${cid}/notice`, { noticeDate: today }).expect(409);
    const t = (await post('hana', `ui-claims/${tomClaim}/notice`, { noticeDate: today, responseDays: 7 }).expect(200)).body; expect(t.responseDue).toBe(plus(7));
  });
  it('the employer response needs substance, a confirmation of accuracy and evidence', async () => {
    await post('hana', `ui-claims/${cid}/respond`, { responseText: 'Laid off', accuracyConfirmed: true }).expect(400);
    await post('hana', `ui-claims/${cid}/respond`, { responseText: 'Position eliminated in a reduction in force on the last day.', accuracyConfirmed: false }).expect(400);
    await post('hana', `ui-claims/${cid}/respond`, { responseText: 'Position eliminated in a reduction in force on the last day.', accuracyConfirmed: true }).expect(400);   // no evidence yet
    await post('hana', `ui-claims/${cid}/evidence`, { kind: 'made-up', title: 'x' }).expect(400); await post('hana', `ui-claims/${cid}/evidence`, { kind: 'notice', title: '' }).expect(400);
    await post('hana', `ui-claims/${cid}/evidence`, { kind: 'notice', title: 'Layoff notice', description: 'Delivered in person', source: 'HR file', docDate: plus(-4) }).expect(201);
    await post('mia', `ui-claims/${cid}/evidence`, { kind: 'notice', title: 'x' }).expect(403);
    const r = (await post('hana', `ui-claims/${cid}/respond`, { responseText: 'Position eliminated in a reduction in force on the last day.', accuracyConfirmed: true }).expect(200)).body;
    expect([r.responseStatus, r.status, r.agencyDecision]).toEqual(['submitted', 'responded', 'pending']);               // the system NEVER decides eligibility
    await post('hana', `ui-claims/${cid}/respond`, { responseText: 'Second response that should not be accepted.', accuracyConfirmed: true }).expect(409);
  });
  it('records the AGENCY determination, keeps appeal deadlines, and blocks late employer appeals', async () => {
    await post('hana', `ui-claims/${cid}/appeal`, { side: 'employer', filedDate: today }).expect(409);                     // nothing to appeal yet
    await post('hana', `ui-claims/${cid}/determination`, { decision: 'maybe', decisionDate: today }).expect(400); await post('hana', `ui-claims/${cid}/determination`, { decision: 'denied', decisionDate: today, appealDays: 0 }).expect(400);
    const r = (await post('hana', `ui-claims/${cid}/determination`, { decision: 'eligible', decisionDate: today, weeklyBenefit: 450, benefitWeeks: 26, appealDays: 14, notes: 'Per agency letter' }).expect(200)).body;
    expect([r.agencyDecision, r.status, r.appealDeadline]).toEqual(['eligible', 'determined', plus(14)]);
    await post('hana', `ui-claims/${cid}/determination`, { decision: 'denied', decisionDate: today }).expect(409);
    await post('hana', `ui-claims/${cid}/appeal`, { side: 'employer', filedDate: plus(20) }).expect(409);                  // after the deadline
    await post('hana', `ui-claims/${cid}/appeal`, { side: 'employer', filedDate: plus(5), notes: 'Contesting the reason' }).expect(201);
    await post('hana', `ui-claims/${cid}/appeal`, { side: 'employer', filedDate: plus(6) }).expect(409);
    expect((await get('hana', `ui-claims/${cid}`).expect(200)).body).toMatchObject({ status: 'appealed' });
    const full = (await get('hana', `ui-claims/${cid}`).expect(200)).body; expect(full.correspondence.map((c: any) => c.direction)).toEqual(expect.arrayContaining(['from_agency', 'to_agency'])); expect(full.evidence.length).toBe(1);
    expect(await M.AuditLog.count({ where: { action: 'UI Agency Determination Recorded' } })).toBe(1);
    await post('hana', `ui-claims/${cid}/close`, { note: 'Appeal pending: closing for now' }).expect(200); await post('hana', `ui-claims/${cid}/close`, {}).expect(409);
  });
  it('the daily job warns two days before the deadline and escalates a missed response once', async () => {
    await M.UiClaim.update({ responseDue: plus(1) } as any, { where: { id: tomClaim } });
    expect((await runUiJob()).reminded).toBe(1); expect((await runUiJob()).reminded).toBe(0);
    await M.UiClaim.update({ responseDue: plus(-1) } as any, { where: { id: tomClaim } });
    expect((await runUiJob()).missed).toBe(1); expect((await runUiJob()).missed).toBe(0);
    expect(((await M.UiClaim.findByPk(tomClaim)) as any).responseStatus).toBe('missed');
    expect(await M.Notification.count({ where: { userId: id.hana, title: 'UI response deadline MISSED' } })).toBe(1);
    await post('hana', `ui-claims/${tomClaim}/respond`, { responseText: 'Responding although late: performance reviews attached.', accuracyConfirmed: true }).expect(409);   // missed: record correspondence instead
  });
  it('claims are company-private', async () => {
    const co2: any = await M.Company.create({ name: 'Other Co', slug: 'other' } as any);
    const h2: any = await runAs(co2.id, () => mk('Hera', 'hr')); const t2 = (await request(app).post('/api/auth/login').send({ email: 'hera@t.test', password: PW })).body.token;
    expect((await request(app).get('/api/ui-claims').set('Authorization', 'Bearer ' + t2).expect(200)).body.length).toBe(0);
    await request(app).get(`/api/ui-claims/${cid}`).set('Authorization', 'Bearer ' + t2).expect(404); expect(h2.companyId).toBe(co2.id);
  });
});

describe('A8 insurance register', () => {
  let pid: number;
  const pol = { type: 'Cyber Liability', insurer: 'Acme Mutual', policyNumber: 'CY-100', coverageLimit: 1000000, premium: 4800, premiumFrequency: 'annual', effectiveDate: plus(-300), expirationDate: plus(65), exclusions: 'War, infrastructure failure', claimsContact: { name: 'Claims desk', phone: '555-0100', email: 'claims@acme.test' } };
  it('lists all 15 types with gaps, and only HR can use the register', async () => {
    await get('mia', 'insurance').expect(403); await get('eli', 'insurance/types').expect(403);
    const t = (await get('hana', 'insurance/types').expect(200)).body; expect(t.length).toBe(15); expect(t.every((x: any) => x.activePolicies === 0)).toBe(true);
    expect(t.find((x: any) => x.no === 2).note).toMatch(/payroll-tax/); expect(t.find((x: any) => x.no === 12).note).toMatch(/EPLI/);
  });
  it('validates policies and refuses duplicates', async () => {
    await post('mia', 'insurance', pol).expect(403);
    await post('hana', 'insurance', { ...pol, type: 'Pet Rock Insurance' }).expect(400); await post('hana', 'insurance', { ...pol, insurer: '' }).expect(400);
    await post('hana', 'insurance', { ...pol, premium: -5 }).expect(400); await post('hana', 'insurance', { ...pol, premiumFrequency: 'weekly' }).expect(400);
    await post('hana', 'insurance', { ...pol, expirationDate: pol.effectiveDate }).expect(400); await post('hana', 'insurance', { ...pol, effectiveDate: 'nope' }).expect(400);
    pid = (await post('hana', 'insurance', pol).expect(201)).body.id; await post('hana', 'insurance', pol).expect(409);
    expect((await get('hana', 'insurance/types').expect(200)).body.find((x: any) => x.type === 'Cyber Liability').activePolicies).toBe(1);
  });
  it('covered people and assets, documents and an audited update', async () => {
    await post('hana', `insurance/${pid}/insured`, { kind: 'person', employeeId: 99999 }).expect(404);
    await post('hana', `insurance/${pid}/insured`, { kind: 'asset', label: '' }).expect(400);
    await post('hana', `insurance/${pid}/insured`, { kind: 'person', employeeId: id.omar, details: 'Key person: CTO' }).expect(201);
    const asset = (await post('hana', `insurance/${pid}/insured`, { kind: 'asset', label: 'Primary data centre rack' }).expect(201)).body;
    await post('hana', `insurance/${pid}/documents`, { kind: 'certificate', title: 'Certificate of insurance 2026', reference: 'drive://coi-2026.pdf', issuedDate: plus(-300) }).expect(201); await post('hana', `insurance/${pid}/documents`, { kind: 'bogus', title: 'x' }).expect(400);
    const d = (await get('hana', `insurance/${pid}`).expect(200)).body; expect(d.insured.map((i: any) => i.label)).toEqual(expect.arrayContaining(['Omar', 'Primary data centre rack'])); expect(d.documents.length).toBe(1); expect(d.claimsContact.phone).toBe('555-0100');
    await request(app).delete(`/api/insurance/${pid}/insured/${asset.id}`).set(as('hana')).expect(200); await request(app).delete(`/api/insurance/${pid}/insured/${asset.id}`).set(as('hana')).expect(404);
    await request(app).patch(`/api/insurance/${pid}`).set(as('hana')).send({ coverageLimit: 2000000, premium: 5200 }).expect(200);
    expect(await M.AuditLog.count({ where: { action: 'Insurance Policy Updated' } })).toBe(1); expect(((await M.InsurancePolicy.findByPk(pid)) as any).coverageLimit).toBe('2000000.00');
    await request(app).patch(`/api/insurance/${pid}`).set(as('hana')).send({ expirationDate: pol.effectiveDate }).expect(400);
  });
  it('renewal reminders go out once per threshold; expiry marks the policy expired with a compliance task; a renewal reactivates it', async () => {
    const set = (d: number) => M.InsurancePolicy.update({ expirationDate: plus(d) } as any, { where: { id: pid } });
    const nHR = () => M.Notification.count({ where: { userId: id.hana, title: 'Insurance renewal coming up' } });
    await set(25); expect((await runInsuranceJob()).reminders).toBe(1); expect((await runInsuranceJob()).reminders).toBe(0); expect(await nHR()).toBe(1);   // 30-day threshold
    await set(5); expect((await runInsuranceJob()).reminders).toBe(1); expect((await runInsuranceJob()).reminders).toBe(0);                                       // 7-day threshold
    expect((await get('hana', 'insurance/renewals').expect(200)).body[0]).toMatchObject({ bucket: 'd7' });
    await set(-1); expect((await runInsuranceJob()).expired).toBe(1); expect((await runInsuranceJob()).expired).toBe(0);
    expect(((await M.InsurancePolicy.findByPk(pid)) as any).status).toBe('expired');
    expect(await M.ComplianceTask.count({ where: { type: 'Insurance expired: Cyber Liability (CY-100)' } })).toBe(1);
    expect((await get('hana', 'insurance/types').expect(200)).body.find((x: any) => x.type === 'Cyber Liability').activePolicies).toBe(0);                      // a gap again
    await request(app).patch(`/api/insurance/${pid}`).set(as('hana')).send({ expirationDate: plus(365) }).expect(200);
    const p: any = await M.InsurancePolicy.findByPk(pid); expect([p.status, (p.remindersSent || []).length]).toEqual(['active', 0]);
  });
});
