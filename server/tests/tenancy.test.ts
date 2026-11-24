import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { setTestDefaultTenant, runAs, runSystem } from '../src/tenancy';
import { runScheduledJobs } from '../src/jobs';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9'; const X = { 'X-Requested-With': 'ams' };
const emp = (companyId: number, name: string, role: string, extra: any = {}) => runAs(companyId, () => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, status: 'active', password: bcrypt.hashSync(PW, 4), ...extra } as any)) as Promise<any>;
const sys = <T>(fn: () => Promise<T>) => runSystem(fn);
/** Sign in with email + password only (no second step). */
async function signIn(email: string, password = PW) {
  const a = request.agent(app);
  const r = await a.post('/api/auth/login').send({ email, password });
  return { a, r };
}
let A: any, B: any, adminA: any, adminB: any, inviteA = '', ids: Record<string, number> = {};

beforeAll(async () => {
  setTestDefaultTenant(undefined);
  await M.sequelize.sync({ force: true });
  await sys(() => M.Employee.create({ name: 'Owner', email: 'owner@t.test', role: 'superadmin', status: 'active', companyId: null, password: bcrypt.hashSync(PW, 4) } as any));
});
afterAll(() => { setTestDefaultTenant(1); });

describe('P14 platform console and invites (email + password only)', () => {
  let owner: any;
  it('super admin signs in with email + password only; cookie is httpOnly + SameSite; no MFA fields or routes exist', async () => {
    const a = request.agent(app); const r = await a.post('/api/auth/login').send({ email: 'owner@t.test', password: PW }).expect(200);
    expect(r.body.mfaRequired).toBeUndefined(); expect(r.body.mustChangePassword).toBe(false);
    const ck = String(r.headers['set-cookie']); expect(ck).toMatch(/HttpOnly/i); expect(ck).toMatch(/SameSite=Lax/i);
    const me = (await a.get('/api/auth/me').expect(200)).body; expect(me.mfaPending).toBeUndefined(); expect(me.mfaRequired).toBeUndefined();
    for (const path of ['setup', 'confirm', 'verify']) { const x = await a.post(`/api/auth/mfa/${path}`).set(X).send({}); expect(x.status).toBeGreaterThanOrEqual(400); expect(x.body.secret).toBeUndefined(); expect(x.body.recoveryCodes).toBeUndefined(); }   // route no longer exists: it falls through to the company guard, which refuses a platform account
    await a.get('/api/platform/companies').expect(200);
    owner = a;
  });
  it('creates companies with validation; company users cannot use the console', async () => {
    const bad = (b: any, st: number) => owner.post('/api/platform/companies').set(X).send({ name: 'X Co', slug: 'x-co', adminName: 'N', adminEmail: 'n@x.test', plan: 'starter', ...b }).expect(st);
    await bad({ slug: 'Bad Slug!' }, 400); await bad({ plan: 'platinum' }, 400); await bad({ adminEmail: 'nope' }, 400); await bad({ name: '' }, 400);
    const a1 = await owner.post('/api/platform/companies').set(X).send({ name: 'Acme Inc', slug: 'acme', adminName: 'Ada Admin', adminEmail: 'ada@acme.test', plan: 'enterprise' }).expect(201);
    inviteA = a1.body.inviteToken; A = a1.body.company;
    const b1 = await owner.post('/api/platform/companies').set(X).send({ name: 'Globex', slug: 'globex', adminName: 'Gus Admin', adminEmail: 'gus@globex.test', plan: 'enterprise' }).expect(201); B = b1.body.company;
    await owner.post('/api/platform/companies').set(X).send({ name: 'Dup', slug: 'acme', adminName: 'N', adminEmail: 'z@x.test' }).expect(409);
    await owner.post('/api/platform/companies').set(X).send({ name: 'Dup', slug: 'dup-co', adminName: 'N', adminEmail: 'ada@acme.test' }).expect(409);
    await request(app).post('/api/auth/login').send({ email: 'ada@acme.test', password: 'whatever-whatever' }).expect(401);   // invited, not active
    await owner.get('/api/platform/companies').expect(200).expect((x) => expect(x.body.map((c: any) => c.slug)).toEqual(expect.arrayContaining(['acme', 'globex'])));
    // invite acceptance
    await request(app).post('/api/auth/accept-invite').send({ token: inviteA, password: 'short' }).expect(400);
    await request(app).post('/api/auth/accept-invite').send({ token: 'nope', password: PW }).expect(400);
    await request(app).post('/api/auth/accept-invite').send({ token: inviteA, password: PW }).expect(200);
    await request(app).post('/api/auth/accept-invite').send({ token: inviteA, password: PW }).expect(400);      // single use
    const g = await owner.post(`/api/platform/companies/${B.id}/reinvite`).set(X).send().expect(200);
    await request(app).post('/api/auth/accept-invite').send({ token: g.body.inviteToken, password: PW }).expect(200);
    adminA = (await signIn('ada@acme.test')).a; adminB = (await signIn('gus@globex.test')).a;
    await adminA.get('/api/platform/companies').expect(401);                                                    // not a super admin
    await adminA.get('/api/employees').expect(200);
    const o = await request.agent(app); await o.post('/api/auth/login').send({ email: 'owner@t.test', password: PW });
    await o.get('/api/employees').expect(403);                                                                  // super admin has no company access
    await owner.get('/api/employees').expect(403);                                                              // not a company account
  });
  it('wrong passwords count toward lockout and the lock holds even for the right password', async () => {
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email: 'gus@globex.test', password: 'wrong-wrong-wrong-' + i }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'gus@globex.test', password: PW }).expect(423);
    await sys(() => M.Employee.unscoped().update({ lockedUntil: null, failedAttempts: 0 }, { where: { email: 'gus@globex.test' } }));
    await request(app).post('/api/auth/login').send({ email: 'gus@globex.test', password: PW }).expect(200);
  });
  it('admin sessions reach company routes immediately after login (no second step)', async () => {
    const a = request.agent(app); await a.post('/api/auth/login').send({ email: 'ada@acme.test', password: PW }).expect(200);
    await a.get('/api/employees').expect(200); await a.post('/api/auth/logout').set(X).send().expect(200);
  });
});

describe('tenant isolation (every query is company-scoped)', () => {
  let a1: any, a2: any, b1: any, leaveA: any, tsA: any, credA: any, candA: any;
  beforeAll(async () => {
    a1 = await emp(A.id, 'Ann', 'employee', { hourlyRate: 20 }); a2 = await emp(A.id, 'Hal', 'hr'); b1 = await emp(B.id, 'Bob', 'employee');
    leaveA = await runAs(A.id, () => M.LeaveRequest.create({ employeeId: a1.id, type: 'Annual', startDate: '2026-12-01', endDate: '2026-12-01', hours: 8 } as any)) as any;
    tsA = await runAs(A.id, () => M.Timesheet.create({ employeeId: a1.id, periodStart: '2026-11-02', periodEnd: '2026-11-08', status: 'submitted', regularHours: 40 } as any)) as any;
    credA = await runAs(A.id, () => M.Credential.create({ employeeId: a1.id, name: 'AcmeCert', expiryDate: '2026-12-31', status: 'pending' } as any)) as any;
    candA = await runAs(A.id, () => M.Candidate.create({ name: 'Cand A', position: 'Dev' } as any)) as any;
    await runAs(A.id, () => M.PaySheet.create({ employeeId: a1.id, period: '2026-10' } as any));
  });
  it('company B admin cannot see or touch company A data by id (404) and the attempts are logged', async () => {
    await adminB.post(`/api/leave/${leaveA.id}/decide`).set(X).send({ approve: true }).expect(404);
    await adminB.post(`/api/timesheets/${tsA.id}/decide`).set(X).send({ approve: true }).expect(404);
    await adminB.post(`/api/credentials/${credA.id}/verify`).set(X).send({ valid: true }).expect(404);
    await adminB.get(`/api/candidates/${candA.id}`).expect(404);
    expect(((await runAs(A.id, () => M.LeaveRequest.findByPk(leaveA.id))) as any).status).toBe('pending');
    expect(((await runAs(A.id, () => M.Credential.findByPk(credA.id))) as any).status).toBe('pending');
    const ev: any[] = await runAs(B.id, () => M.SecurityEvent.findAll({ where: { type: 'cross_company_attempt' }, raw: true })) as any;
    expect(ev.length).toBeGreaterThanOrEqual(3); expect(ev.every((e) => e.companyId === B.id)).toBe(true);
  });
  it('company B admin cannot reset the password of a company A user (404, password untouched) and a global email clash gives 409', async () => {
    const before = ((await sys(() => M.Employee.unscoped().findByPk(a1.id))) as any).password;
    await adminB.post(`/api/employees/${a1.id}/reset-password`).set(X).send({ password: 'Another-Long-Pass-88', confirmPassword: 'Another-Long-Pass-88' }).expect(404);
    expect(((await sys(() => M.Employee.unscoped().findByPk(a1.id))) as any).password).toBe(before);
    await adminB.post('/api/employees').set(X).send({ name: 'Clash', email: a1.email, role: 'employee', password: 'Another-Long-Pass-88', confirmPassword: 'Another-Long-Pass-88' }).expect(409);
  });
  it('lists never mix companies', async () => {
    const mine = (await adminB.get('/api/employees').expect(200)).body.map((e: any) => e.name);
    expect(mine).toContain('Bob'); expect(mine).not.toContain('Ann'); expect(mine).not.toContain('Hal');
    for (const url of ['leave', 'timesheets', 'credentials', 'candidates', 'payroll']) {
      const r = await adminB.get('/api/' + url).expect(200); const list = Array.isArray(r.body) ? r.body : r.body.rows || r.body.data || [];
      expect(JSON.stringify(list)).not.toContain('AcmeCert'); expect(list.some((x: any) => x.employeeId === a1.id)).toBe(false);
    }
  });
  it('employee records never expose secret fields', async () => {
    const keys = new Set((await adminA.get('/api/employees').expect(200)).body.flatMap((e: any) => Object.keys(e)));
    for (const k of ['password', 'inviteTokenHash']) expect(keys.has(k)).toBe(false);
  });
  it('model hooks: reads, counts, bulk update and bulk destroy are filtered; inserts are stamped; cross-company writes blocked', async () => {
    expect(((await runAs(A.id, () => M.Employee.findAll())) as any[]).every((e) => e.companyId === A.id)).toBe(true);
    const cA = await runAs(A.id, () => M.Employee.count()), cB = await runAs(B.id, () => M.Employee.count()), all = await runSystem(() => M.Employee.count());
    expect(cA + cB + 1).toBe(all);                                                                              // +1 = super admin (no company)
    await runAs(A.id, () => M.Employee.update({ title: 'Updated' } as any, { where: {} }));
    expect(((await runAs(B.id, () => M.Employee.findByPk(b1.id))) as any).title).not.toBe('Updated');
    expect(await runAs(A.id, () => M.Employee.findByPk(b1.id))).toBeNull();                                     // another company's row is invisible
    await runAs(A.id, () => M.Notification.create({ userId: a1.id, title: 'a' } as any)); await runAs(B.id, () => M.Notification.create({ userId: b1.id, title: 'b' } as any));
    await runAs(A.id, () => M.Notification.destroy({ where: {} }));
    expect(await runAs(B.id, () => M.Notification.count())).toBeGreaterThan(0);
    const n: any = await runAs(A.id, () => M.Notification.create({ userId: a1.id, title: 'stamp' } as any)); expect(n.companyId).toBe(A.id);
    await expect(runAs(A.id, () => M.Notification.create({ userId: 1, title: 'x', companyId: B.id } as any))).rejects.toThrow(/Cross-company/);
  });
  it('public careers pages are per company slug', async () => {
    const job: any = await runAs(A.id, () => M.Requisition.create({ title: 'Acme Engineer', department: 'Eng', workState: 'TX', city: 'Austin', status: 'open', headcount: 1, description: 'x', postedAt: new Date() } as any));
    const list = (s: string) => request(app).get(`/api/public/${s}/jobs`);
    expect(JSON.stringify((await list('acme').expect(200)).body)).toContain('Acme Engineer');
    expect(JSON.stringify((await list('globex').expect(200)).body)).not.toContain('Acme Engineer');
    await request(app).get(`/api/public/globex/jobs/${job.id}`).expect(404);
    await request(app).post(`/api/public/globex/jobs/${job.id}/apply`).send({ name: 'X', email: 'x@x.test' }).expect(404);
    await list('nope').expect(404);
  });
  it('scheduled jobs run per company: reminders never reach another company', async () => {
    const soon = new Date(Date.now() + 25 * 864e5).toISOString().slice(0, 10);
    await runAs(A.id, () => M.Credential.create({ employeeId: a1.id, name: 'AcmeReminder', expiryDate: soon, status: 'verified' } as any));
    await runAs(B.id, () => M.Credential.create({ employeeId: b1.id, name: 'GlobexReminder', expiryDate: soon, status: 'verified' } as any));
    await runScheduledJobs();
    const notes = (c: number) => runAs(c, () => M.Notification.findAll({ raw: true })) as Promise<any[]>;
    const na = JSON.stringify(await notes(A.id)), nb = JSON.stringify(await notes(B.id));
    expect(na).toContain('AcmeReminder'); expect(na).not.toContain('GlobexReminder'); expect(nb).toContain('GlobexReminder'); expect(nb).not.toContain('AcmeReminder');
  });
});

describe('sessions: cookies, CSRF, idle timeout, revocation', () => {
  let ann: any;
  it('cookie requests need the custom header on writes (CSRF); reads do not', async () => {
    ann = (await signIn('ann@t.test')).a;
    await ann.get('/api/employees').expect(200);
    await ann.post('/api/leave').send({ type: 'Annual', startDate: '2026-12-02', endDate: '2026-12-02', hours: 8 }).expect(403).expect((x) => expect(x.body.error).toMatch(/CSRF/));
    const ok = await ann.post('/api/leave').set(X).send({ type: 'Annual', startDate: '2026-12-02', endDate: '2026-12-02', hours: 8 }); expect(ok.status).not.toBe(403);
  });
  it('expires after 15 idle minutes and after the absolute limit', async () => {
    const a = (await signIn('ann@t.test')).a; await a.get('/api/employees').expect(200);
    await sys(() => M.Session.update({ lastSeenAt: new Date(Date.now() - 16 * 60_000) } as any, { where: { employeeId: ids.ann ?? 0 } })).catch(() => null);
    const annRow: any = await runAs(A.id, () => M.Employee.findOne({ where: { email: 'ann@t.test' } }));
    await sys(() => M.Session.update({ lastSeenAt: new Date(Date.now() - 16 * 60_000) } as any, { where: { employeeId: annRow.id } }));
    await a.get('/api/employees').expect(401);
    const b = (await signIn('ann@t.test')).a; await b.get('/api/employees').expect(200);
    await sys(() => M.Session.update({ expiresAt: new Date(Date.now() - 1000) } as any, { where: { employeeId: annRow.id, revokedAt: null } }));
    await b.get('/api/employees').expect(401);
  });
  it('logout revokes the token server-side', async () => {
    const a = request.agent(app); const r = await a.post('/api/auth/login').send({ email: 'ann@t.test', password: PW }).expect(200);
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    await request(app).get('/api/employees').set('Cookie', cookie).expect(200);
    await a.post('/api/auth/logout').set(X).send().expect(200);
    await request(app).get('/api/employees').set('Cookie', cookie).expect(401);
  });
  it('changing the password signs out other devices', async () => {
    const d1 = (await signIn('ann@t.test')).a, d2 = (await signIn('ann@t.test')).a;
    await d1.post('/api/auth/change-password').set(X).send({ current: 'wrong-wrong-wrong', next: 'Another-Long-Pass-77' }).expect(401);
    await d1.post('/api/auth/change-password').set(X).send({ current: PW, next: 'short' }).expect(400);
    await d1.post('/api/auth/change-password').set(X).send({ current: PW, next: 'Another-Long-Pass-77' }).expect(200);
    await d2.get('/api/employees').expect(401); await d1.get('/api/employees').expect(200);
    await request(app).post('/api/auth/login').send({ email: 'ann@t.test', password: PW }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'ann@t.test', password: 'Another-Long-Pass-77' }).expect(200);
  });
  it('a terminated employee loses the session immediately', async () => {
    const hal = (await signIn('hal@t.test')).a; await hal.get('/api/employees').expect(200);
    await runAs(A.id, () => M.Employee.update({ status: 'terminated' } as any, { where: { email: 'hal@t.test' } }));
    await hal.get('/api/employees').expect(401);
    await runAs(A.id, () => M.Employee.update({ status: 'active' } as any, { where: { email: 'hal@t.test' } }));
  });
  it('suspending a company kills its sessions and blocks login; reactivating restores it', async () => {
    const o = (await signIn('owner@t.test')).a; const live = (await signIn('ann@t.test', 'Another-Long-Pass-77')).a; await live.get('/api/employees').expect(200);
    await o.patch(`/api/platform/companies/${A.id}`).set(X).send({ status: 'suspended' }).expect(200);
    await live.get('/api/employees').expect(401);
    await request(app).post('/api/auth/login').send({ email: 'ann@t.test', password: 'Another-Long-Pass-77' }).expect(401);
    await adminB.get('/api/employees').expect(200);                                                             // other companies unaffected
    await o.patch(`/api/platform/companies/${A.id}`).set(X).send({ status: 'active' }).expect(200);
    await request(app).post('/api/auth/login').send({ email: 'ann@t.test', password: 'Another-Long-Pass-77' }).expect(200);
  });
  it('bearer tokens are refused unless explicitly enabled (never in production)', async () => {
    const prev = process.env.ALLOW_BEARER; process.env.ALLOW_BEARER = 'false';
    try {
      const r = await request(app).post('/api/auth/login').send({ email: 'ann@t.test', password: 'Another-Long-Pass-77' }); expect(r.body.token).toBeUndefined();
      await request(app).get('/api/employees').set('Authorization', 'Bearer ' + (r.headers['set-cookie'] ? String(r.headers['set-cookie']).split(';')[0].split('=')[1] : 'x')).expect(401);   // even the real token is not accepted as a bearer
    } finally { process.env.ALLOW_BEARER = prev; }
  });
});

describe('P12 plan gating by subscription state', () => {
  it('feature gates, read-only and cancelled modes are enforced on every request', async () => {
    const o = (await signIn('owner@t.test')).a; const hdr = (p: any) => o.patch(`/api/platform/companies/${B.id}`).set(X).send(p).expect(200);
    await hdr({ plan: 'starter', subState: 'active' });
    await adminB.get('/api/employees').expect(200);
    await adminB.get('/api/credentials').expect(403).expect((x) => expect(x.body.error).toMatch(/Starter/i));
    await adminB.get('/api/candidates').expect(403);
    await hdr({ plan: 'growth' }); await adminB.get('/api/credentials').expect(200); await adminB.get('/api/sales').expect(403);
    await hdr({ plan: 'professional' }); await adminB.get('/api/sales').expect(200);
    await hdr({ subState: 'read_only' }); await adminB.get('/api/employees').expect(200);
    await adminB.post('/api/employees').set(X).send({ name: 'Nope', email: 'nope@t.test' }).expect(402);
    await hdr({ subState: 'cancelled' }); await adminB.get('/api/employees').expect(402);
    await hdr({ plan: 'enterprise', subState: 'active' }); await adminB.get('/api/employees').expect(200);
  });
});
