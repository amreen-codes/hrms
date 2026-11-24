import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { runSystem } from '../src/tenancy';
import { passwordProblem, assignableRoles, canAssignRole, canResetPassword, MAX_PW_BYTES } from '../src/accountCore';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9', INIT = 'Initial-Pass-Word-1', NEW = 'Brand-New-Passphrase-7';
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra } as any) as any;
const login = (email: string, password = PW) => request(app).post('/api/auth/login').send({ email, password });
const tokenOf = async (email: string, password = PW) => (await login(email, password).expect(200)).body.token as string;
const bearer = (t: string) => ({ Authorization: 'Bearer ' + t });
const raw = (email: string) => runSystem(() => M.Employee.unscoped().findOne({ where: { email } })) as Promise<any>;
const create = (t: string, body: any) => request(app).post('/api/employees').set(bearer(t)).send(body);
let T: Record<string, string> = {};

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const mgr = await mk('Mia', 'manager'); await mk('Ada', 'admin'); await mk('Hana', 'hr'); await mk('Eli', 'employee', { managerId: mgr.id });
  await runSystem(() => M.Employee.unscoped().create({ name: 'Platform Owner', email: 'owner@t.test', role: 'superadmin', status: 'active', companyId: null, password: bcrypt.hashSync(PW, 4) } as any));
  for (const n of ['ada', 'hana', 'mia', 'eli']) T[n] = await tokenOf(`${n}@t.test`);
});

describe('account rules (pure)', () => {
  it('password policy: length, 72-byte bcrypt limit, not the email', () => {
    expect(passwordProblem('')).toMatch(/required/); expect(passwordProblem('short')).toMatch(/at least 12/); expect(passwordProblem(undefined)).toMatch(/required/);
    expect(passwordProblem('x'.repeat(MAX_PW_BYTES + 1))).toMatch(/at most/); expect(passwordProblem('x'.repeat(MAX_PW_BYTES))).toBeNull();
    expect(passwordProblem('person@example.com', 'Person@Example.com')).toMatch(/email/); expect(passwordProblem(INIT)).toBeNull();
  });
  it('who may assign which role; superadmin is never assignable', () => {
    expect(assignableRoles('admin')).toEqual(['admin', 'hr', 'manager', 'employee']); expect(assignableRoles('hr')).toEqual(['manager', 'employee']);
    for (const r of ['manager', 'employee', 'superadmin', 'x']) expect(assignableRoles(r)).toEqual([]);
    for (const actor of ['admin', 'hr', 'manager', 'employee', 'superadmin']) expect(canAssignRole(actor, 'superadmin')).toBe(false);
    expect(canAssignRole('admin', 'root')).toBe(false); expect(canAssignRole('admin', undefined)).toBe(false);
    expect(canResetPassword('admin', 'employee')).toBe(true); expect(canResetPassword('hr', 'employee')).toBe(false); expect(canResetPassword('admin', 'superadmin')).toBe(false);
  });
});

describe('login without MFA, every role', () => {
  it('super admin, admin, HR, manager and employee sign in with email + password only', async () => {
    for (const email of ['owner@t.test', 'ada@t.test', 'hana@t.test', 'mia@t.test', 'eli@t.test']) {
      const r = await login(email).expect(200);
      expect(r.body.mfaRequired).toBeUndefined(); expect(r.body.mfaEnrolled).toBeUndefined(); expect(r.body.mustChangePassword).toBe(false);
      const me = await request(app).get('/api/auth/me').set(bearer(r.body.token)).expect(200);
      expect(me.body.mfaPending).toBeUndefined(); expect(me.body.mustChangePassword).toBe(false);
    }
  });
  it('every company role reaches its data straight after login; a super admin reaches the platform console only', async () => {
    for (const n of ['ada', 'hana', 'mia', 'eli']) await request(app).get('/api/employees').set(bearer(T[n])).expect(200);
    const o = await tokenOf('owner@t.test');
    await request(app).get('/api/platform/companies').set(bearer(o)).expect(200); await request(app).get('/api/employees').set(bearer(o)).expect(403);
  });
  it('MFA routes are gone, and no MFA columns are on the model or leak in responses', async () => {
    for (const p of ['setup', 'confirm', 'verify']) { const r = await request(app).post(`/api/auth/mfa/${p}`).set(bearer(T.ada)).send({}); expect(r.status).toBe(404); }
    const cols = Object.keys((M.Employee as any).rawAttributes); expect(cols.filter((c) => /mfa/i.test(c))).toEqual([]);
    expect(Object.keys((M.Session as any).rawAttributes).filter((c) => /mfa/i.test(c))).toEqual([]);
  });
  it('a wrong password and an unknown email give the same message; lockout after 5 failures still works', async () => {
    const a = await login('eli@t.test', 'wrong-wrong-wrong').expect(401), b = await login('nobody@t.test', 'wrong-wrong-wrong').expect(401);
    expect(a.body.error).toBe(b.body.error);
    await mk('Lou', 'employee');
    for (let i = 0; i < 5; i++) await login('lou@t.test', 'bad-password-' + i).expect(401);
    await login('lou@t.test', PW).expect(423);
  });
  it('existing users created before this change keep working with no forced change', async () => {
    await mk('Old', 'employee');   // no mustChangePassword set = how every existing row looks after the migration
    const r = await login('old@t.test').expect(200); expect(r.body.mustChangePassword).toBe(false);
    await request(app).get('/api/employees').set(bearer(r.body.token)).expect(200);
  });
});

describe('admin creates accounts with a manual initial password', () => {
  it('Admin can create admin, HR, manager and employee accounts; each has its own unique email and a hashed password', async () => {
    for (const role of ['admin', 'hr', 'manager', 'employee']) {
      const email = `new-${role}@t.test`;
      const r = await create(T.ada, { name: `New ${role}`, email, role, password: INIT, confirmPassword: INIT }).expect(200);
      expect(r.body.role).toBe(role); expect(r.body.mustChangePassword).toBe(true); expect(r.body.tempPassword).toBeUndefined();
      const row = await raw(email); expect(row.role).toBe(role); expect(row.password).not.toContain(INIT); expect(bcrypt.compareSync(INIT, row.password)).toBe(true); expect(row.password).toMatch(/^\$2[aby]\$12\$/);
    }
    await create(T.ada, { name: 'Dup', email: 'NEW-HR@t.test', role: 'hr', password: INIT, confirmPassword: INIT }).expect(409);   // email unique, case-insensitive
  });
  it('validation: mismatched / short / over-long passwords, bad email, bad role', async () => {
    const base = { name: 'V', email: 'v@t.test', role: 'employee', password: INIT, confirmPassword: INIT };
    await create(T.ada, { ...base, confirmPassword: INIT + 'x' }).expect(400);
    await create(T.ada, { ...base, confirmPassword: undefined }).expect(400);
    await create(T.ada, { ...base, password: 'short', confirmPassword: 'short' }).expect(400);
    await create(T.ada, { ...base, password: 'x'.repeat(80), confirmPassword: 'x'.repeat(80) }).expect(400);
    await create(T.ada, { ...base, email: 'not-an-email' }).expect(400);
    await create(T.ada, { ...base, name: '' }).expect(400);
    expect(await raw('v@t.test')).toBeNull();
  });
  it('nobody can create or assign a Super Admin; unknown roles are refused (never silently downgraded)', async () => {
    for (const role of ['superadmin', 'root', 'Admin ', '']) if (role !== '') await create(T.ada, { name: 'S', email: 's@t.test', role, password: INIT, confirmPassword: INIT }).expect(403);
    expect(await raw('s@t.test')).toBeNull();
    const r = await create(T.ada, { name: 'Dflt', email: 'dflt@t.test', password: INIT, confirmPassword: INIT }).expect(200); expect(r.body.role).toBe('employee');   // role omitted = employee
  });
  it('HR may add employees and managers only; manager and employee cannot create accounts at all', async () => {
    await create(T.hana, { name: 'Hr Emp', email: 'hr-emp@t.test', role: 'employee', password: INIT, confirmPassword: INIT }).expect(200);
    await create(T.hana, { name: 'Hr Mgr', email: 'hr-mgr@t.test', role: 'manager', password: INIT, confirmPassword: INIT }).expect(200);
    for (const role of ['hr', 'admin', 'superadmin']) await create(T.hana, { name: 'X', email: `hr-${role}@t.test`, role, password: INIT, confirmPassword: INIT }).expect(403);
    for (const n of ['mia', 'eli']) await create(T[n], { name: 'X', email: `${n}-x@t.test`, role: 'employee', password: INIT, confirmPassword: INIT }).expect(403);
    for (const e of ['hr-hr', 'hr-admin', 'hr-superadmin', 'mia-x', 'eli-x']) expect(await raw(`${e}@t.test`)).toBeNull();
  });
  it('the form cannot smuggle protected fields (status, company, lockout, must-change flag, id)', async () => {
    const r = await create(T.ada, { name: 'Smug', email: 'smug@t.test', role: 'employee', password: INIT, confirmPassword: INIT, status: 'active', mustChangePassword: false, companyId: 999, id: 777, failedAttempts: 0, passwordChangedAt: '2000-01-01' }).expect(200);
    const row = await raw('smug@t.test'); expect(row.id).toBe(r.body.id); expect(row.id).not.toBe(777); expect(row.companyId).toBe(1); expect(row.status).toBe('onboarding'); expect(!!row.mustChangePassword).toBe(true); expect(row.passwordChangedAt).toBeNull();
  });
  it('without a password the server still generates a random one (shown once) and forces a change', async () => {
    const r = await create(T.ada, { name: 'Gen', email: 'gen@t.test', role: 'employee' }).expect(200);
    expect(String(r.body.tempPassword).length).toBeGreaterThanOrEqual(12); expect(r.body.mustChangePassword).toBe(true);
    expect((await login('gen@t.test', r.body.tempPassword).expect(200)).body.mustChangePassword).toBe(true);
  });
});

describe('first-login password change', () => {
  it('a new user is blocked everywhere except /auth/me, /auth/logout and /auth/change-password until the password is changed', async () => {
    const r = await login('new-employee@t.test', INIT).expect(200); expect(r.body.mustChangePassword).toBe(true); const t = r.body.token;
    for (const path of ['/api/employees', '/api/dashboard', '/api/leave', '/api/attendance']) await request(app).get(path).set(bearer(t)).expect(403).expect((x) => expect(x.body.mustChangePassword).toBe(true));
    await request(app).post('/api/attendance/clock').set(bearer(t)).expect(403);
    const me = await request(app).get('/api/auth/me').set(bearer(t)).expect(200); expect(me.body.mustChangePassword).toBe(true);
    const ch = (b: any) => request(app).post('/api/auth/change-password').set(bearer(t)).send(b);
    await ch({ current: 'wrong-current-pass', next: NEW }).expect(401);                                  // current password is verified
    await ch({ current: INIT, next: INIT }).expect(400);                                                 // must differ
    await ch({ current: INIT, next: 'short' }).expect(400);                                              // policy
    await ch({ current: INIT, next: NEW, confirm: NEW + 'x' }).expect(400);                              // confirmation must match when sent
    expect(!!(await raw('new-employee@t.test')).mustChangePassword).toBe(true);
    await ch({ current: INIT, next: NEW, confirm: NEW }).expect(200);
    expect(!!(await raw('new-employee@t.test')).mustChangePassword).toBe(false);
    await request(app).get('/api/employees').set(bearer(t)).expect(200);                                 // same session is fully open now
    await login('new-employee@t.test', INIT).expect(401); expect((await login('new-employee@t.test', NEW).expect(200)).body.mustChangePassword).toBe(false);
  });
  it('a forced-change HR or admin account is blocked from admin routes too, and the super admin console guard honours the flag', async () => {
    const t = await tokenOf('new-admin@t.test', INIT);
    await request(app).get('/api/employees').set(bearer(t)).expect(403);
    await create(t, { name: 'Sneaky', email: 'sneaky@t.test', role: 'employee', password: INIT, confirmPassword: INIT }).expect(403);
    await request(app).post('/api/employees/1/reset-password').set(bearer(t)).send({ password: NEW, confirmPassword: NEW }).expect(403);
    await runSystem(() => M.Employee.unscoped().update({ mustChangePassword: true }, { where: { email: 'owner@t.test' } }));
    const o = await tokenOf('owner@t.test'); await request(app).get('/api/platform/companies').set(bearer(o)).expect(403).expect((x) => expect(x.body.mustChangePassword).toBe(true));
    await request(app).post('/api/auth/change-password').set(bearer(o)).send({ current: PW, next: NEW }).expect(200);
    await request(app).get('/api/platform/companies').set(bearer(o)).expect(200);
    await runSystem(() => M.Employee.unscoped().update({ password: bcrypt.hashSync(PW, 4) }, { where: { email: 'owner@t.test' } }));
  });
  it('changing the password writes an audit entry and no plain-text password appears in the audit log', async () => {
    const rows: any[] = await M.AuditLog.findAll({ raw: true }); const text = JSON.stringify(rows);
    expect(text).toContain('Password Changed'); for (const p of [INIT, NEW, PW]) expect(text).not.toContain(p);
  });
});

describe('admin password reset', () => {
  it('only an Admin can reset; the person must change it at next login, is signed out everywhere and any lockout is cleared', async () => {
    const eli = await raw('eli@t.test'); const oldTok = T.eli;
    await request(app).get('/api/employees').set(bearer(oldTok)).expect(200);
    for (const n of ['hana', 'mia', 'eli']) await request(app).post(`/api/employees/${eli.id}/reset-password`).set(bearer(T[n])).send({ password: NEW, confirmPassword: NEW }).expect(403);
    await runSystem(() => M.Employee.unscoped().update({ lockedUntil: new Date(Date.now() + 600_000), failedAttempts: 3 }, { where: { id: eli.id } }));
    await request(app).post(`/api/employees/${eli.id}/reset-password`).set(bearer(T.ada)).send({ password: NEW, confirmPassword: NEW }).expect(200);
    const after = await raw('eli@t.test'); expect(after.lockedUntil).toBeNull(); expect(after.failedAttempts).toBe(0); expect(!!after.mustChangePassword).toBe(true); expect(after.password).not.toContain(NEW); expect(bcrypt.compareSync(NEW, after.password)).toBe(true);
    await request(app).get('/api/employees').set(bearer(oldTok)).expect(401);                          // old session revoked
    await login('eli@t.test', PW).expect(401);                                                         // old password dead
    const r = await login('eli@t.test', NEW).expect(200); expect(r.body.mustChangePassword).toBe(true);
    await request(app).get('/api/employees').set(bearer(r.body.token)).expect(403);
    await request(app).post('/api/auth/change-password').set(bearer(r.body.token)).send({ current: NEW, next: PW + '-v2' }).expect(200);
    await request(app).get('/api/employees').set(bearer(r.body.token)).expect(200);
    T.eli = await tokenOf('eli@t.test', PW + '-v2');
  });
  it('validation and guards: mismatch, weak, self, unknown id, invited, super admin', async () => {
    const eli = await raw('eli@t.test'), ada = await raw('ada@t.test'), owner = await raw('owner@t.test');
    const rp = (id: number | string, b: any) => request(app).post(`/api/employees/${id}/reset-password`).set(bearer(T.ada)).send(b);
    await rp(eli.id, { password: NEW, confirmPassword: NEW + 'x' }).expect(400); await rp(eli.id, { password: 'short', confirmPassword: 'short' }).expect(400); await rp(eli.id, {}).expect(400);
    await rp(ada.id, { password: NEW, confirmPassword: NEW }).expect(400);                              // own password: use change-password
    await rp(999999, { password: NEW, confirmPassword: NEW }).expect(404); await rp('abc', { password: NEW, confirmPassword: NEW }).expect(404);
    await rp(owner.id, { password: NEW, confirmPassword: NEW }).expect(404);                            // platform account is outside the company
    const inv = await mk('Invitee', 'employee', { status: 'invited' }); await rp(inv.id, { password: NEW, confirmPassword: NEW }).expect(409);
    expect(bcrypt.compareSync(PW + '-v2', (await raw('eli@t.test')).password)).toBe(true);              // nothing above changed Eli
  });
  it('the reset is audited without the password', async () => {
    const rows: any[] = await M.AuditLog.findAll({ raw: true }); const text = JSON.stringify(rows);
    expect(text).toContain('Password Reset'); expect(text).not.toContain(NEW);
  });
  it('an unauthenticated request cannot reset or create', async () => {
    await request(app).post('/api/employees/1/reset-password').send({ password: NEW, confirmPassword: NEW }).expect(401);
    await request(app).post('/api/employees').send({ name: 'X', email: 'x@t.test' }).expect(401);
  });
});

describe('health check', () => {
  it('is public, cheap and reveals nothing', async () => { const r = await request(app).get('/api/health').expect(200); expect(r.body).toEqual({ ok: true }); });
});
