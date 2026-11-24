import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { runCredentialReminders, sweepLifecycle } from '../src/lifecycle';
import { addDays, todayStr } from '../src/lifecycleCore';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const ids: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase().replace(/\s/g, '')}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const login = async (email: string) => (await request(app).post('/api/auth/login').send({ email, password: PW })).body.token as string;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n] });
const today = todayStr();
const I9 = { lastName: 'Khan', firstName: 'Nia', street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', dob: '1991-04-03', ssn: '123-45-6789', citizenshipStatus: 'citizen', attestation: true, signedName: 'Nia Khan' };
const W4 = { firstName: 'Nia', lastName: 'Khan', ssn: '123-45-6789', street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', filingStatus: 'single', attestation: true, signedName: 'Nia Khan' };
const DOC = { documentChoice: 'list_a', documents: [{ listType: 'A', title: 'US Passport', issuingAuthority: 'USA', documentNumber: '987654321' }], examinedOn: today, employerRepName: 'Hana HR', attestation: true };
const tasks = async (employeeId: number, kind = 'onboarding') => (await M.LifecycleTask.findAll({ where: { employeeId, kind }, raw: true })) as any[];
const notes = async (userId: number, like: string) => ((await M.Notification.findAll({ where: { userId }, raw: true })) as any[]).filter((n) => n.title.includes(like));

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const hr: any = await mk('Hana HR', 'hr'), mgr: any = await mk('Mia', 'manager'), eli: any = await mk('Eli', 'employee', { managerId: null, startDate: '2025-01-06' }), omar: any = await mk('Omar', 'employee');
  await eli.update({ managerId: mgr.id });
  Object.assign(ids, { hr: hr.id, mgr: mgr.id, eli: eli.id, omar: omar.id });
  for (const [k, e] of [['hr', 'hanahr'], ['mgr', 'mia'], ['eli', 'eli'], ['omar', 'omar']]) tok[k] = await login(`${e}@t.test`);
});

describe('P5 onboarding', () => {
  let nia = 0;
  it('creating an employee generates the checklist, moves sensitive data out of the profile and hides the profile from managers', async () => {
    const r = await request(app).post('/api/employees').set(as('hr')).send({ name: 'Nia Khan', email: 'nia@t.test', password: PW, confirmPassword: PW, startDate: today, department: 'Eng', title: 'Dev', managerId: ids.mgr,
      profile: { filingStatus: 'single', dob: '1991-04-03', ecName: 'Sam Khan', ecRelation: 'Brother', ecPhone: '555-123-4567', city: 'Austin', benefits: { waive: true } } }).expect(200);
    nia = r.body.id; expect(r.body.mustChangePassword).toBe(true); await M.Employee.unscoped().update({ mustChangePassword: false }, { where: { id: nia } }); tok.nia = await login('nia@t.test');
    const t = await tasks(nia); expect(t.length).toBe(8); expect(t.find((x) => x.key === 'emergency').status).toBe('done'); expect(t.find((x) => x.key === 'i9_s1').status).toBe('open');
    const emp: any = await M.Employee.findByPk(nia); expect(JSON.stringify(emp.profile)).not.toContain('filingStatus'); expect(JSON.stringify(emp.profile)).not.toContain('1991-04-03'); expect(JSON.stringify(emp.profile)).not.toContain('Sam Khan');
    expect(((await M.EmergencyContact.findOne({ where: { employeeId: nia }, raw: true })) as any).name).toBe('Sam Khan');
    const list = await request(app).get('/api/employees').set(as('mgr')).expect(200); expect(JSON.stringify(list.body)).not.toContain('"profile"');
    expect((await notes(nia, 'onboarding checklist')).length).toBe(1);
  });
  it('I-9 Section 1 is stored encrypted, only by the employee, once; audit log holds no values', async () => {
    await request(app).post(`/api/onboarding/${nia}/i9-section1`).set(as('hr')).send(I9).expect(403);
    await request(app).post(`/api/onboarding/${nia}/i9-section1`).set(as('nia')).send({ ...I9, attestation: false }).expect(400);
    await request(app).post(`/api/onboarding/${nia}/i9-section1`).set(as('nia')).send(I9).expect(201);
    await request(app).post(`/api/onboarding/${nia}/i9-section1`).set(as('nia')).send(I9).expect(409);
    const row: any = await M.SensitiveForm.findOne({ where: { employeeId: nia, form: 'i9_s1' }, raw: true });
    for (const plain of ['123456789', '123-45-6789', 'Khan', '1991-04-03', 'Austin']) expect(row.data).not.toContain(plain);
    expect(row.data.startsWith('v1.')).toBe(true);
    const audit = JSON.stringify(await M.AuditLog.findAll({ raw: true })); expect(audit).not.toContain('123456789'); expect(audit).not.toContain('1991-04-03'); expect(audit).toContain('I-9 Section 1 Submitted');
    expect((await tasks(nia)).find((x) => x.key === 'i9_s1').status).toBe('done');
  });
  it('W-4: SSN encrypted; HR sees it decrypted (audited); the employee sees it masked; a manager is refused', async () => {
    await request(app).post(`/api/onboarding/${nia}/w4`).set(as('nia')).send({ ...W4, ssn: '000-12-3456' }).expect(400);
    await request(app).post(`/api/onboarding/${nia}/w4`).set(as('nia')).send(W4).expect(201);
    expect(((await M.SensitiveForm.findOne({ where: { employeeId: nia, form: 'w4' }, raw: true })) as any).data).not.toContain('123456789');
    const hrView = await request(app).get(`/api/onboarding/${nia}/sensitive/w4`).set(as('hr')).expect(200); expect(hrView.body.data.ssn).toBe('123456789'); expect(hrView.body.masked).toBe(false);
    expect((await M.AuditLog.findAll({ where: { action: 'Sensitive Data Viewed' }, raw: true })).length).toBe(1);
    const self = await request(app).get(`/api/onboarding/${nia}/sensitive/w4`).set(as('nia')).expect(200); expect(self.body.data.ssn).toBe('***-**-6789'); expect(self.body.masked).toBe(true);
    await request(app).get(`/api/onboarding/${nia}/sensitive/w4`).set(as('mgr')).expect(403); await request(app).get(`/api/onboarding/${nia}/sensitive/w4`).set(as('omar')).expect(403);
  });
  it('handbook e-sign needs the exact name and stores user, time, IP and version', async () => {
    await request(app).post(`/api/onboarding/${nia}/handbook`).set(as('nia')).send({ accept: true, signedName: 'Someone Else' }).expect(400);
    await request(app).post(`/api/onboarding/${nia}/handbook`).set(as('nia')).send({ accept: false, signedName: 'Nia Khan' }).expect(400);
    await request(app).post(`/api/onboarding/${nia}/handbook`).set(as('nia')).send({ accept: true, signedName: 'nia khan' }).expect(201);
    const sig: any = await M.PolicySignature.findOne({ where: { employeeId: nia }, raw: true }); expect(sig.version).toBe('2026.1'); expect(sig.ip).toBeTruthy(); expect(sig.signedAt).toBeTruthy();
    await request(app).post(`/api/onboarding/${nia}/handbook`).set(as('nia')).send({ accept: true, signedName: 'Nia Khan' }).expect(409);
  });
  it('auto tasks cannot be ticked by hand; manual tasks need their preconditions', async () => {
    const t = await tasks(nia); const id = (k: string) => t.find((x) => x.key === k).id;
    await request(app).post(`/api/lifecycle/tasks/${id('i9_s2')}/complete`).set(as('hr')).send({}).expect(409);
    await request(app).post(`/api/lifecycle/tasks/${id('w4_verify')}/complete`).set(as('nia')).send({}).expect(403);
    await request(app).post(`/api/lifecycle/tasks/${id('mgr_ack')}/complete`).set(as('omar')).send({}).expect(403);
  });
  it('Section 2: HR only, not for themselves; a late completion creates a compliance task', async () => {
    await request(app).post(`/api/onboarding/${nia}/i9-section2`).set(as('mgr')).send(DOC).expect(403);
    const late = await request(app).post(`/api/onboarding/${ids.eli}/i9-section2`).set(as('hr')).send(DOC).expect(409); expect(late.body.error).toContain('Section 1');
    const ok = await request(app).post(`/api/onboarding/${nia}/i9-section2`).set(as('hr')).send(DOC).expect(201); expect(ok.body.late).toBe(false);
    expect((await M.SensitiveForm.findOne({ where: { employeeId: nia, form: 'i9_s2' }, raw: true }) as any).data).not.toContain('987654321');
  });
  it('late Section 2 (start date long ago) raises a compliance task', async () => {
    const lateEmp: any = await mk('Late Larry', 'employee', { startDate: '2026-01-05', status: 'onboarding' }); tok.larry = await login('latelarry@t.test');
    await M.LifecycleTask.bulkCreate([{ employeeId: lateEmp.id, kind: 'onboarding', key: 'i9_s2', title: 'x', ownerRole: 'hr', mandatory: true, auto: true, dueDate: '2026-01-08' }] as any);
    await request(app).post(`/api/onboarding/${lateEmp.id}/i9-section1`).set(as('larry')).send({ ...I9, firstName: 'Larry' }).expect(201);
    const r = await request(app).post(`/api/onboarding/${lateEmp.id}/i9-section2`).set(as('hr')).send(DOC).expect(201); expect(r.body.late).toBe(true);
    expect((await M.ComplianceTask.findAll({ where: { employeeId: lateEmp.id }, raw: true }) as any[]).some((c) => c.type.includes('completed late'))).toBe(true);
  });
  it('assign manager and equipment, verify W-4, then the employee becomes Active; chase notifies owners', async () => {
    const t = await tasks(nia); const id = (k: string) => t.find((x) => x.key === k).id;
    await request(app).post(`/api/onboarding/${nia}/assign`).set(as('hr')).send({ managerId: nia }).expect(400);
    expect(((await request(app).post(`/api/onboarding/${nia}/chase`).set(as('hr')).expect(200)).body.pending)).toBeGreaterThan(0);
    await request(app).post(`/api/onboarding/${nia}/assign`).set(as('hr')).send({ managerId: ids.mgr, equipment: [{ item: 'Laptop', assetTag: 'LT-1' }] }).expect(200);
    expect(((await M.Employee.findByPk(nia)) as any).status).toBe('onboarding');
    await request(app).post(`/api/lifecycle/tasks/${id('w4_verify')}/complete`).set(as('hr')).send({}).expect(200);
    expect(((await M.Employee.findByPk(nia)) as any).status).toBe('active');
    expect((await notes(nia, 'Onboarding complete')).length).toBe(1);
    await request(app).post(`/api/lifecycle/tasks/${id('mgr_ack')}/complete`).set(as('mgr')).send({}).expect(200);
  });
  it('overdue tasks are escalated once into a compliance task', async () => {
    const e: any = await mk('Slow Sam', 'employee', { startDate: '2026-01-05', status: 'onboarding' });
    await M.LifecycleTask.create({ employeeId: e.id, kind: 'onboarding', key: 'w4', title: 'Fill W-4 digitally', ownerRole: 'employee', mandatory: true, auto: true, dueDate: '2026-01-08' } as any);
    const a = await sweepLifecycle(); const b = await sweepLifecycle(); expect(a.escalated).toBeGreaterThan(0); expect(b.escalated).toBe(0);
    expect((await M.ComplianceTask.count({ where: { employeeId: e.id } }))).toBe(1);
  });
  it('an employee only sees their own onboarding; a stranger is refused', async () => {
    await request(app).get(`/api/onboarding/${nia}`).set(as('omar')).expect(403);
    expect((await request(app).get('/api/onboarding').set(as('nia')).expect(200)).body.map((x: any) => x.id)).toEqual([nia]);
    expect((await request(app).get('/api/onboarding').set(as('hr')).expect(200)).body.length).toBeGreaterThan(1);
  });
});

describe('P7 credentials and expiry reminders', () => {
  const cred = (days: number, over: any = {}) => ({ type: 'License', name: 'RN License', issuer: 'State Board', expiryDate: addDays(today, days), documentRef: 'rn-license.pdf', ...over });
  const at = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 864e5);
  let cid = 0;
  it('employee uploads, cannot verify their own, HR verifies; invalid input is refused', async () => {
    await request(app).post('/api/credentials').set(as('eli')).send(cred(100, { expiryDate: 'nope' })).expect(400);
    await request(app).post('/api/credentials').set(as('eli')).send(cred(100, { documentRef: '' })).expect(400);
    await request(app).post('/api/credentials').set(as('eli')).send({ ...cred(100), employeeId: ids.omar }).expect(403);
    cid = (await request(app).post('/api/credentials').set(as('eli')).send(cred(100)).expect(201)).body.id;
    await request(app).post(`/api/credentials/${cid}/verify`).set(as('eli')).send({ approve: true }).expect(403);
    await request(app).post(`/api/credentials/${cid}/verify`).set(as('mgr')).send({ approve: true }).expect(403);
    await request(app).post(`/api/credentials/${cid}/verify`).set(as('hr')).send({ approve: false }).expect(400);
    await request(app).post(`/api/credentials/${cid}/verify`).set(as('hr')).send({ approve: true }).expect(200);
    await request(app).post(`/api/credentials/${cid}/verify`).set(as('hr')).send({ approve: true }).expect(409);
  });
  it('reminders fire once each at 90, 60, 30 and 7 days to employee, manager and HR', async () => {
    const seen: number[] = [];
    for (let off = 0; off <= 99; off++) { const r = await runCredentialReminders(at(off)); r.reminders.filter((x) => x.id === cid).forEach((x) => seen.push(x.threshold)); }
    expect(seen).toEqual([90, 60, 30, 7]);
    for (const uid of [ids.eli, ids.mgr, ids.hr]) expect((await notes(uid, 'RN License expires in')).length).toBe(4);
    expect((await notes(ids.omar, 'RN License')).length).toBe(0);
    expect(((await M.Credential.findByPk(cid)) as any).lastReminderDays).toBe(7);
  });
  it('on expiry: status Expired, compliance task, notifications, once only; dashboard flags the employee', async () => {
    const r1 = await runCredentialReminders(at(101)); expect(r1.expired).toEqual([cid]); const r2 = await runCredentialReminders(at(102)); expect(r2.expired).toEqual([]);
    expect(((await M.Credential.findByPk(cid)) as any).status).toBe('expired'); expect((await M.ComplianceTask.count({ where: { employeeId: ids.eli, status: 'overdue' } }))).toBe(1);
    expect((await notes(ids.hr, 'Credential expired')).length).toBe(1);
    const sum = (await request(app).get('/api/credentials/summary').set(as('hr')).expect(200)).body; expect(sum.expired).toBe(1); expect(sum.flaggedEmployees[0].id).toBe(ids.eli);
  });
  it('renewal: pending until verified, then the old record is superseded and reminders restart', async () => {
    await request(app).post(`/api/credentials/${cid}/renew`).set(as('omar')).send(cred(400)).expect(403);
    await request(app).post(`/api/credentials/${cid}/renew`).set(as('eli')).send(cred(5)).expect(400);          // must expire after the current one
    const nid = (await request(app).post(`/api/credentials/${cid}/renew`).set(as('eli')).send(cred(400)).expect(201)).body.id;
    await request(app).post(`/api/credentials/${cid}/renew`).set(as('eli')).send(cred(401)).expect(409);        // one pending renewal at a time
    await request(app).post(`/api/credentials/${nid}/verify`).set(as('hr')).send({ approve: true }).expect(200);
    expect(((await M.Credential.findByPk(cid)) as any).status).toBe('superseded');
    const list = (await request(app).get('/api/credentials').set(as('eli')).expect(200)).body; expect(list.map((c: any) => c.id)).toEqual([nid]); expect(list[0].bucket).toBe('compliant');
  });
  it('a credential that already expired cannot be verified; managers see their team only', async () => {
    const id2 = (await request(app).post('/api/credentials').set(as('omar')).send(cred(-1)).expect(201)).body.id;
    expect((await request(app).post(`/api/credentials/${id2}/verify`).set(as('hr')).send({ approve: true }).expect(400)).body.error).toContain('expired');
    const mine = (await request(app).get('/api/credentials').set(as('mgr')).expect(200)).body; expect(mine.every((c: any) => c.employeeId !== ids.omar)).toBe(true);
    await request(app).post('/api/credentials/run-reminders').set(as('mgr')).expect(403);
  });
});

describe('P8 offboarding', () => {
  let eid = 0, oid = 0;
  it('only HR can start it; validation; the reason is restricted from managers', async () => {
    const e: any = await mk('Leaver Lee', 'employee', { managerId: ids.mgr, startDate: '2024-03-04' }); eid = e.id; tok.lee = await login('leaverlee@t.test');
    await request(app).post('/api/offboarding').set(as('mgr')).send({ employeeId: eid, terminationDate: today, reason: 'resignation' }).expect(403);
    await request(app).post('/api/offboarding').set(as('hr')).send({ employeeId: eid, terminationDate: '2020-01-01', reason: 'resignation' }).expect(400);
    await request(app).post('/api/offboarding').set(as('hr')).send({ employeeId: eid, terminationDate: today, reason: 'because' }).expect(400);
    await request(app).post('/api/offboarding').set(as('hr')).send({ employeeId: ids.hr, terminationDate: today, reason: 'resignation' }).expect(400);
    const r = await request(app).post('/api/offboarding').set(as('hr')).send({ employeeId: eid, terminationDate: addDays(today, 3), reason: 'layoff', notes: 'restricted note' }).expect(201); oid = r.body.id;
    expect((await tasks(eid, 'offboarding')).length).toBe(7); expect(r.body.accessRevokedAt).toBeFalsy();
    await request(app).post('/api/offboarding').set(as('hr')).send({ employeeId: eid, terminationDate: addDays(today, 3), reason: 'layoff' }).expect(409);
    const mv = (await request(app).get(`/api/offboarding/${oid}`).set(as('mgr')).expect(200)).body; expect(mv.reason).toBeUndefined(); expect(mv.notes).toBeUndefined();
    expect((await request(app).get(`/api/offboarding/${oid}`).set(as('hr')).expect(200)).body.reason).toBe('layoff');
    expect(JSON.stringify(await M.AuditLog.findAll({ raw: true }))).not.toContain('restricted note');
    await request(app).get('/api/offboarding').set(as('lee')).expect(403);
  });
  it('access stays until the termination date; cancelling before then is allowed and restores the record', async () => {
    await request(app).get('/api/attendance/status').set(as('lee')).expect(200);
    await request(app).post(`/api/offboarding/${oid}/cancel`).set(as('hr')).expect(200);
    expect((await tasks(eid, 'offboarding')).every((t) => t.status === 'cancelled')).toBe(true);
    await request(app).post('/api/offboarding').set(as('hr')).send({ employeeId: eid, terminationDate: today, reason: 'resignation', notes: 'x' }).expect(201).then((r) => { oid = r.body.id; });
  });
  it('on the termination date access is revoked: tokens and login stop working', async () => {
    expect(((await M.Employee.findByPk(eid)) as any).accessRevokedAt).toBeTruthy();
    await request(app).get('/api/attendance/status').set(as('lee')).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'leaverlee@t.test', password: PW }).expect(401);
    expect(((await M.Employee.findByPk(eid)) as any).status).toBe('active');            // not Terminated until the checklist is done
    await request(app).post(`/api/offboarding/${oid}/cancel`).set(as('hr')).expect(409);
  });
  it('task rules: manager handover, assets must be returned, final pay and notices need a note, retention cannot be shortened', async () => {
    await M.Asset.create({ employeeId: eid, item: 'Laptop', assetTag: 'LT-9', status: 'assigned', assignedAt: today } as any);
    const t = await tasks(eid, 'offboarding'); const id = (k: string) => t.find((x) => x.key === k).id; const done = (k: string, who: string, body: any = {}) => request(app).post(`/api/lifecycle/tasks/${id(k)}/complete`).set(as(who)).send(body);
    await done('revoke_access', 'hr').expect(409);                              // automatic
    await done('handover', 'omar').expect(403); await done('handover', 'mgr').expect(200);
    expect((await done('collect_assets', 'hr').expect(409)).body.error).toContain('asset');
    const asset: any = await M.Asset.findOne({ where: { employeeId: eid } });
    await request(app).post(`/api/assets/${asset.id}/return`).set(as('hr')).send({ status: 'missing' }).expect(400);
    await request(app).post(`/api/assets/${asset.id}/return`).set(as('hr')).send({ status: 'returned' }).expect(200);
    await done('collect_assets', 'hr').expect(200);
    await done('final_pay', 'hr').expect(400); await done('final_pay', 'hr', { note: 'Final sheet 2026-11' }).expect(200);
    await done('benefits_notice', 'hr', { note: 'COBRA notice mailed' }).expect(200); await done('exit_interview', 'hr').expect(200);
    const det = (await request(app).get(`/api/offboarding/${oid}`).set(as('hr')).expect(200)).body;
    await request(app).post(`/api/offboarding/${oid}/retention`).set(as('hr')).send({ retentionUntil: today }).expect(400);
    expect(((await M.Employee.findByPk(eid)) as any).status).toBe('active');            // retention still open
    await request(app).post(`/api/offboarding/${oid}/retention`).set(as('hr')).send({ retentionUntil: det.suggestedRetention }).expect(200);
  });
  it('when every mandatory task is done the employee is Terminated and the offboarding is complete', async () => {
    expect(((await M.Employee.findByPk(eid)) as any).status).toBe('terminated'); expect(((await M.Offboarding.findByPk(oid)) as any).status).toBe('complete');
    expect((await M.AuditLog.findAll({ where: { action: 'Offboarding Complete' }, raw: true })).length).toBe(1);
  });
  it('the old terminate endpoint is gone; encryption key rotation is admin-only', async () => {
    await request(app).post(`/api/employees/${ids.omar}/terminate`).set(as('hr')).expect(404);
    await request(app).post('/api/security/rotate-keys').set(as('hr')).expect(403);
  });
});

describe('global search', () => {
  it('is scoped like /employees, rejects short terms and treats % and _ literally', async () => {
    await request(app).get('/api/search?q=a').set(as('hr')).expect(400);
    await request(app).get('/api/search?q=Eli').set(as('omar')).expect(200).then((r) => expect(r.body).toEqual([]));          // employee sees only themselves
    expect((await request(app).get('/api/search?q=Eli').set(as('mgr')).expect(200)).body.map((x: any) => x.id)).toEqual([ids.eli]); // manager: own team
    expect((await request(app).get('/api/search?q=Omar').set(as('hr')).expect(200)).body.length).toBe(1);
    expect((await request(app).get('/api/search?q=%25%25').set(as('hr')).expect(200)).body).toEqual([]);                           // "%%" is not a wildcard
    await request(app).get('/api/search?q=Eli').expect(401);
    expect(JSON.stringify((await request(app).get('/api/search?q=Eli').set(as('hr'))).body)).not.toContain('password');
  });
});
