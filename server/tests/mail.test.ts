import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { runSystem } from '../src/tenancy';
import { setMailTransport, flushMail, sendMail, appBase } from '../src/mail';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const sent: any[] = []; let failNext = false;
const fake = async (_cfg: any, m: any) => { if (failNext) { failNext = false; throw new Error('550 mailbox unavailable'); } sent.push(m); };
const smtpOn = () => { Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_FROM: 'noreply@ams.test' }); setMailTransport(fake as any); };
const smtpOff = () => { delete process.env.SMTP_HOST; delete process.env.SMTP_FROM; delete process.env.NOTIFY_EMAIL; setMailTransport(null); };
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra } as any) as any;
const tok = async (email: string) => (await request(app).post('/api/auth/login').send({ email, password: PW })).body.token as string;
const as = (t: string) => ({ Authorization: 'Bearer ' + t });
const logs = () => runSystem(() => M.EmailLog.findAll({ order: [['id', 'ASC']], raw: true })) as Promise<any[]>;
let owner = '', hr = '';

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  await mk('Hana', 'hr'); await mk('Eli', 'employee');
  await runSystem(() => M.Employee.unscoped().create({ name: 'Owner', email: 'owner@t.test', role: 'superadmin', status: 'active', companyId: null, password: bcrypt.hashSync(PW, 4) } as any));
  owner = await tok('owner@t.test'); hr = await tok('hana@t.test');
});
afterEach(() => { smtpOff(); sent.length = 0; });

describe('invitation e-mail', () => {
  const create = (slug: string, email: string) => request(app).post('/api/platform/companies').set(as(owner)).send({ name: 'Acme ' + slug, slug, adminName: 'Ada Admin', adminEmail: email, plan: 'growth' });
  it('mails the invite link to the new admin; the link is also returned once for manual sending', async () => {
    smtpOn(); const r = await create('acme-co', 'ada@acme.test').expect(201);
    expect(r.body.emailed).toBe(true); expect(sent.length).toBe(1); expect(sent[0].to).toBe('ada@acme.test'); expect(sent[0].text).toContain(r.body.inviteUrl); expect(sent[0].text).toContain('72 hours'); expect(sent[0].subject).toContain('Acme acme-co');
    expect(r.body.inviteUrl.startsWith(appBase() + '/accept-invite?token=')).toBe(true);
    const l = (await logs()).find((x) => x.kind === 'invite'); expect(l.status).toBe('sent'); expect(JSON.stringify(l)).not.toContain(r.body.inviteToken);   // the token is never logged
  });
  it('without SMTP the invite is not emailed (skipped is logged) and company creation still works', async () => {
    const r = await create('beta-co', 'bo@beta.test').expect(201); expect(r.body.emailed).toBe(false); expect(r.body.inviteUrl).toContain('/accept-invite?token='); expect((await logs()).some((x) => x.toEmail === 'bo@beta.test' && x.status === 'skipped')).toBe(true);
  });
  it('a mail server error is logged as failed and never breaks the request; re-invite mails again', async () => {
    smtpOn(); failNext = true; const r = await create('gamma-co', 'gus@gamma.test').expect(201); expect(r.body.emailed).toBe(false);
    const l = (await logs()).find((x) => x.toEmail === 'gus@gamma.test'); expect(l.status).toBe('failed'); expect(l.error).toContain('550');
    const co: any = await runSystem(() => M.Company.findOne({ where: { slug: 'gamma-co' } }));
    const again = await request(app).post(`/api/platform/companies/${co.id}/reinvite`).set(as(owner)).expect(200); expect(again.body.emailed).toBe(true); expect(sent.at(-1).to).toBe('gus@gamma.test');
  });
});

describe('notification alerts', () => {
  it('off by default; with NOTIFY_EMAIL=true only the title is mailed (never the body) and only to active people', async () => {
    const eli: any = await M.Employee.findOne({ where: { email: 'eli@t.test' } });
    smtpOn(); await M.Notification.create({ userId: eli.id, type: 'x', title: 'Leave request approved', body: 'SECRET DETAIL Sick leave for surgery' } as any); await flushMail(); expect(sent.length).toBe(0);   // NOTIFY_EMAIL not set
    process.env.NOTIFY_EMAIL = 'true'; await M.Notification.create({ userId: eli.id, type: 'x', title: 'Leave request approved', body: 'SECRET DETAIL Sick leave for surgery' } as any); await new Promise((r) => setTimeout(r, 200)); await flushMail();
    expect(sent.length).toBe(1); expect(sent[0].to).toBe('eli@t.test'); expect(sent[0].subject).toContain('Leave request approved'); expect(sent[0].text).not.toContain('SECRET'); expect(JSON.stringify(await logs())).not.toContain('SECRET');
    await M.Notification.bulkCreate([{ userId: eli.id, type: 'x', title: 'One' }, { userId: eli.id, type: 'x', title: 'Two' }] as any); await new Promise((r) => setTimeout(r, 200)); await flushMail(); expect(sent.length).toBe(3);
    await M.Employee.update({ status: 'terminated' }, { where: { id: eli.id } }); await M.Notification.create({ userId: eli.id, type: 'x', title: 'Late' } as any); await new Promise((r) => setTimeout(r, 200)); await flushMail(); expect(sent.length).toBe(3);
    await M.Employee.update({ status: 'active' }, { where: { id: eli.id } });
  });
});

describe('candidate messages through SMTP', () => {
  const msg = () => M.CandidateMessage.create({ candidateId: 1, kind: 'welcome', toEmail: 'cand@x.test', subject: 'Welcome', body: 'Hello candidate', status: 'queued' } as any) as any;
  it('HR only; 503 when SMTP is not configured (stays queued); 502 on a mail error (stays queued); sent once, then 409', async () => {
    const m = await msg(); const eli = await tok('eli@t.test');
    await request(app).post(`/api/recruitment/messages/${m.id}/send`).set(as(eli)).expect(403);
    await request(app).post(`/api/recruitment/messages/${m.id}/send`).set(as(hr)).expect(503); expect(((await M.CandidateMessage.findByPk(m.id)) as any).status).toBe('queued');
    smtpOn(); failNext = true; await request(app).post(`/api/recruitment/messages/${m.id}/send`).set(as(hr)).expect(502); expect(((await M.CandidateMessage.findByPk(m.id)) as any).status).toBe('queued');
    await request(app).post(`/api/recruitment/messages/${m.id}/send`).set(as(hr)).expect(200); expect(sent.at(-1)).toMatchObject({ to: 'cand@x.test', subject: 'Welcome', text: 'Hello candidate' });
    const row: any = await M.CandidateMessage.findByPk(m.id); expect(row.status).toBe('sent'); expect(row.sentAt).toBeTruthy();
    await request(app).post(`/api/recruitment/messages/${m.id}/send`).set(as(hr)).expect(409); await request(app).post('/api/recruitment/messages/99999/send').set(as(hr)).expect(404);
  });
  it('header injection is refused by the mailer', async () => {
    smtpOn(); setMailTransport(null); process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = '1';
    expect(await sendMail({ to: 'a@b.test\r\nBcc: evil@x.test', subject: 's', text: 't', kind: 'test' })).toBe('failed'); delete process.env.SMTP_PORT;
  });
});
