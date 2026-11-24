/** Super Admin console (P14): create companies, assign plans, invite the first admin, suspend. Not reachable by company users. */
import { Router } from 'express';
import crypto from 'node:crypto';
import { Op } from 'sequelize';
import * as M from './models';
import { als, runSystem } from './tenancy';
import * as S from './security';
import { wrap, bad } from './http';
import { PLANS } from './platformCore';
import { PW_CHANGE_REQUIRED } from './auth';
import { sendMail, inviteText } from './mail';

export const platformRouter = Router();
platformRouter.use('/platform', (q: any, s: any, n: any) => {
  S.authenticate(q).then((a) => {
    if (!a || a.user.role !== 'superadmin') return s.status(401).json({ error: 'Unauthorized' });
    if (a.user.mustChangePassword) return s.status(403).json(PW_CHANGE_REQUIRED);
    q.user = a.user; als.run({ platform: true }, () => n());
  }).catch(n);
});
const invite = async (adminId: number) => {
  const token = crypto.randomBytes(32).toString('base64url');
  await M.Employee.unscoped().update({ inviteTokenHash: S.sha(token), inviteExpiresAt: new Date(Date.now() + 72 * 3600_000) }, { where: { id: adminId } });
  const base = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0];
  const inviteUrl = `${base}/accept-invite?token=${token}`;
  const a: any = await M.Employee.unscoped().findByPk(adminId, { attributes: ['name', 'email', 'companyId'] }), co: any = a?.companyId ? await M.Company.findByPk(a.companyId) : null;
  const emailed = a ? (await sendMail({ to: a.email, kind: 'invite', companyId: a.companyId, subject: `You are invited to ${co?.name || 'AMS HRMS'}`, text: inviteText(a.name, co?.name || 'your company', inviteUrl, 72) })) === 'sent' : false;
  return { inviteToken: token, inviteUrl, expiresInHours: 72, emailed };   // link is also returned once so the Super Admin can send it by hand when SMTP is not configured
};
platformRouter.get('/platform/companies', wrap(async (_q, s) => {
  const cs: any[] = await M.Company.findAll({ order: [['id', 'DESC']], raw: true });
  const counts: any[] = await M.Employee.findAll({ attributes: ['companyId', [M.sequelize.fn('COUNT', M.sequelize.col('id')), 'n']], group: ['companyId'], raw: true });
  s.json(cs.map((c) => ({ ...c, employees: Number(counts.find((x) => x.companyId === c.id)?.n || 0) })));
}));
platformRouter.post('/platform/companies', wrap(async (q, s) => {
  const b = q.body, name = String(b.name || '').trim(), slug = String(b.slug || '').trim().toLowerCase(), email = String(b.adminEmail || '').trim().toLowerCase(), adminName = String(b.adminName || '').trim();
  const plan = String(b.plan || 'starter');
  if (name.length < 2 || name.length > 160) throw bad('Company name is required');
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) throw bad('Slug must be 3-40 characters: letters, numbers and dashes');
  if (!(plan in PLANS)) throw bad('Unknown plan');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !adminName) throw bad('Admin name and a valid email are required');
  if (await M.Company.findOne({ where: { slug } })) throw bad('That slug is taken', 409);
  if (await M.Employee.unscoped().findOne({ where: { email } })) throw bad('That email is already in use', 409);
  const co: any = await M.Company.create({ name, slug, plan, subState: 'trial' } as any);
  const admin: any = await M.Employee.create({ name: adminName, email, role: 'admin', status: 'invited', companyId: co.id, password: crypto.randomBytes(24).toString('hex') /* unusable until the invite is accepted */ } as any);
  await M.AuditLog.create({ actorId: q.user.id, action: 'Company Created', detail: `${name} (${slug}) plan ${plan}`, companyId: co.id } as any);
  s.status(201).json({ company: co, admin: { id: admin.id, email }, ...(await invite(admin.id)) });
}));
platformRouter.patch('/platform/companies/:id', wrap(async (q, s) => {
  const co: any = await M.Company.findByPk(q.params.id); if (!co) throw bad('Not found', 404);
  const up: any = {};
  if (q.body.status !== undefined) { if (!['active', 'suspended'].includes(q.body.status)) throw bad('Unknown status'); up.status = q.body.status; }
  if (q.body.plan !== undefined) { if (!(q.body.plan in PLANS)) throw bad('Unknown plan'); up.plan = q.body.plan; }
  if (q.body.subState !== undefined) { if (!['trial', 'active', 'past_due', 'read_only', 'cancel_pending', 'cancelled'].includes(q.body.subState)) throw bad('Unknown subscription state'); up.subState = q.body.subState; }
  await co.update(up);
  if (up.status === 'suspended') await M.Session.update({ revokedAt: new Date() }, { where: { companyId: co.id, revokedAt: null } });
  await M.AuditLog.create({ actorId: q.user.id, action: 'Company Updated', detail: `${co.slug} ${JSON.stringify(up)}`, companyId: co.id } as any);
  s.json(co);
}));
platformRouter.post('/platform/companies/:id/reinvite', wrap(async (q, s) => {
  const admin: any = await M.Employee.unscoped().findOne({ where: { companyId: Number(q.params.id), role: 'admin', status: 'invited' } });
  if (!admin) throw bad('No pending admin invitation for this company', 404);
  s.json(await invite(admin.id));
}));
