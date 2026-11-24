import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import { log, isHR, teamOf, scopeIds, inScope } from './services';
import { wrap, bad, hr, staff } from './http';
import * as C from './lifecycleCore';
import * as H from './hrCore';
import { finalPay } from './finalPayCore';

export const lifecycleRouter = Router();
/** Keys the Add Employee wizard used to put into Employee.profile (plain JSON). They now belong to the encrypted I-9 / W-4 forms or the emergency-contact table. */
export const SENSITIVE_PROFILE_KEYS = ['filingStatus', 'dependentsCredit', 'extraWithholding', 'ssn', 'dob', 'ecName', 'ecRelation', 'ecPhone'];
const id = (v: any) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id'); return n; };

// ---------------------------------------------------------------- notifications
export async function notify(userIds: (number | null | undefined)[], type: string, title: string, body = '', entityType?: string, entityId?: number) {
  const ids = [...new Set(userIds.filter((x): x is number => !!x))];
  if (ids.length) await M.Notification.bulkCreate(ids.map((userId) => ({ userId, type, title: title.slice(0, 200), body: body.slice(0, 1000), entityType, entityId })) as any);
}
const hrIds = async (): Promise<number[]> => ((await M.Employee.findAll({ where: { role: { [Op.in]: ['admin', 'hr'] }, status: { [Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })) as any[]).map((x) => x.id);

lifecycleRouter.get('/notifications', wrap(async (q, s) => {
  const rows = await M.Notification.findAll({ where: { userId: q.user.id }, order: [['id', 'DESC']], limit: 30 });
  s.json({ unread: await M.Notification.count({ where: { userId: q.user.id, readAt: null } }), notifications: rows });
}));
lifecycleRouter.post('/notifications/read-all', wrap(async (q, s) => { await M.Notification.update({ readAt: new Date() }, { where: { userId: q.user.id, readAt: null } }); s.json({ ok: true }); }));
lifecycleRouter.post('/notifications/:id/read', wrap(async (q, s) => { await M.Notification.update({ readAt: new Date() }, { where: { id: id(q.params.id), userId: q.user.id, readAt: null } }); s.json({ ok: true }); }));

// ---------------------------------------------------------------- access helpers
/** self | hr | manager (direct or indirect manager). Everyone else is refused. */
async function access(u: any, employeeId: number): Promise<'self' | 'hr' | 'manager'> {
  if (u.id === employeeId) return 'self';
  if (isHR(u)) return 'hr';
  if (u.role === 'manager' && (await teamOf(u.id)).includes(employeeId)) return 'manager';
  throw bad('Not allowed for your role', 403);
}
async function employee(employeeId: number): Promise<any> { const e: any = await M.Employee.findByPk(employeeId); if (!e) throw bad('Not found', 404); return e; }
const publicEmp = (e: any) => ({ id: e.id, name: e.name, title: e.title, department: e.department, startDate: e.startDate, status: e.status, managerId: e.managerId });

// ---------------------------------------------------------------- checklist engine (P5 and P8)
async function completeTask(employeeId: number, kind: 'onboarding' | 'offboarding', key: string, by: number | null, note?: string) {
  const [n] = await M.LifecycleTask.update({ status: 'done', completedBy: by, completedAt: new Date(), note: note ? note.slice(0, 500) : null } as any, { where: { employeeId, kind, key, status: 'open' } });
  if (n) await (kind === 'onboarding' ? maybeActivate(employeeId) : maybeFinishOffboarding(employeeId));
  return n > 0;
}
/** P5: "All mandatory tasks done? yes -> Onboarding complete, status Active". */
async function maybeActivate(employeeId: number) {
  const where = { employeeId, kind: 'onboarding', mandatory: true };
  if (!(await M.LifecycleTask.count({ where }))) return;
  if (await M.LifecycleTask.count({ where: { ...where, status: 'open' } })) return;
  const [n] = await M.Employee.update({ status: 'active' }, { where: { id: employeeId, status: 'onboarding' } });
  if (n) { await log(0, 'Onboarding Complete', `#${employeeId}`); await notify([employeeId, ...(await hrIds())], 'onboarding', 'Onboarding complete', 'All mandatory onboarding tasks are done. Status is now Active.', 'employee', employeeId); }
}
export async function startOnboarding(emp: any, actorId: number, preDone: string[] = []) {
  const defs = C.buildChecklist('onboarding', emp.startDate || C.todayStr());
  for (const t of defs) {
    const done = preDone.includes(t.key);
    await M.LifecycleTask.findOrCreate({ where: { employeeId: emp.id, kind: 'onboarding', key: t.key }, defaults: { title: t.title, ownerRole: t.ownerRole, team: t.team, mandatory: t.mandatory, auto: t.auto, dueDate: t.dueDate, status: done ? 'done' : 'open', completedAt: done ? new Date() : null, completedBy: done ? actorId : null } as any });
  }
  await log(actorId, 'Onboarding Started', `#${emp.id} ${defs.length} tasks`);
  await notify([emp.id], 'onboarding', 'Welcome: your onboarding checklist is ready', 'Complete I-9 Section 1, your W-4, the handbook e-sign and an emergency contact.', 'employee', emp.id);
  await notify(await hrIds(), 'onboarding', `New onboarding: ${emp.name}`, 'HR tasks: I-9 Section 2, verify W-4, assign manager and equipment.', 'employee', emp.id);
}

// ---------------------------------------------------------------- P5 onboarding: list and detail
lifecycleRouter.get('/onboarding', wrap(async (q, s) => {
  const ids = await scopeIds(q.user); const tasks: any[] = await M.LifecycleTask.findAll({ where: { kind: 'onboarding', ...inScope(ids) }, raw: true });
  const by = new Map<number, any[]>(); tasks.forEach((t) => by.set(t.employeeId, [...(by.get(t.employeeId) || []), t]));
  const emps: any[] = await M.Employee.findAll({ where: { id: { [Op.in]: [...by.keys()] } } }); const today = C.todayStr();
  s.json(emps.map((e) => { const t = by.get(e.id)!; return { ...publicEmp(e), total: t.length, done: t.filter((x) => x.status === 'done').length,
    mandatoryOpen: t.filter((x) => x.mandatory && x.status === 'open').length, overdue: t.filter((x) => x.status === 'open' && x.dueDate < today).length }; }).sort((a, b) => String(b.startDate).localeCompare(String(a.startDate))));
}));
lifecycleRouter.get('/onboarding/:id', wrap(async (q, s) => {
  const eid = id(q.params.id), who = await access(q.user, eid), e = await employee(eid);
  const forms: any[] = await M.SensitiveForm.findAll({ where: { employeeId: eid }, attributes: ['form', 'completedAt'], raw: true });
  const sig: any = await M.PolicySignature.findOne({ where: { employeeId: eid, document: 'handbook', version: C.HANDBOOK_VERSION }, attributes: ['version', 'signedAt'], raw: true });
  const mgr: any = e.managerId ? await M.Employee.findByPk(e.managerId, { attributes: ['id', 'name'] }) : null;
  s.json({ employee: publicEmp(e), viewer: who, handbookVersion: C.HANDBOOK_VERSION, manager: mgr ? { id: mgr.id, name: mgr.name } : null,
    tasks: await M.LifecycleTask.findAll({ where: { employeeId: eid, kind: 'onboarding' }, order: [['id', 'ASC']] }),
    forms: Object.fromEntries(['i9_s1', 'i9_s2', 'w4'].map((f) => [f, forms.find((x) => x.form === f)?.completedAt ?? null])), handbook: sig ? { version: sig.version, signedAt: sig.signedAt } : null,
    emergencyContact: who === 'manager' ? undefined : await M.EmergencyContact.findOne({ where: { employeeId: eid } }), assets: await M.Asset.findAll({ where: { employeeId: eid }, order: [['id', 'ASC']] }) });
}));

// ---------------------------------------------------------------- P5 encrypted forms
async function saveForm(employeeId: number, form: 'i9_s1' | 'i9_s2' | 'w4', payload: any, by: number) {
  let data: string; try { data = C.encryptJson(payload, C.formAad(form, employeeId)); } catch { throw bad('Secure storage is not configured. Ask an administrator to set DATA_ENCRYPTION_KEY.', 503); }
  try { await M.SensitiveForm.create({ employeeId, form, data, completedAt: new Date(), completedBy: by } as any); }
  catch (x: any) { if (x?.name === 'SequelizeUniqueConstraintError') throw bad('This form has already been submitted. Contact HR to correct it.', 409); throw x; }
}
const selfOnly = async (q: any) => { const eid = id(q.params.id); if (q.user.id !== eid) throw bad('You can only complete your own forms', 403); const e = await employee(eid); if (e.status === 'terminated') throw bad('Not allowed', 403); return e; };
const invalid = (errors: string[]) => bad(errors.join('. '), 400);
// Audit entries record that a form was submitted, never its content.
lifecycleRouter.post('/onboarding/:id/i9-section1', wrap(async (q, s) => {
  const e = await selfOnly(q); const v = C.validateI9S1(q.body); if (!v.ok) throw invalid(v.errors);
  await saveForm(e.id, 'i9_s1', { ...v.clean, signedAt: new Date().toISOString() }, q.user.id); await completeTask(e.id, 'onboarding', 'i9_s1', q.user.id);
  await log(q.user.id, 'I-9 Section 1 Submitted', `employee #${e.id}`); s.status(201).json({ ok: true });
}));
lifecycleRouter.post('/onboarding/:id/w4', wrap(async (q, s) => {
  const e = await selfOnly(q); const v = C.validateW4(q.body); if (!v.ok) throw invalid(v.errors);
  await saveForm(e.id, 'w4', { ...v.clean, signedAt: new Date().toISOString() }, q.user.id); await completeTask(e.id, 'onboarding', 'w4', q.user.id);
  await log(q.user.id, 'W-4 Submitted', `employee #${e.id}`); s.status(201).json({ ok: true });
}));
lifecycleRouter.post('/onboarding/:id/handbook', wrap(async (q, s) => {
  const e = await selfOnly(q); const name = String(q.body.signedName || '').trim().replace(/\s+/g, ' ');
  if (q.body.accept !== true) throw bad('You must confirm that you have read and accept the handbook and policies');
  if (name.toLowerCase() !== String(e.name).trim().replace(/\s+/g, ' ').toLowerCase()) throw bad('Type your full name exactly as it appears on your profile to sign');
  try { await M.PolicySignature.create({ employeeId: e.id, document: 'handbook', version: C.HANDBOOK_VERSION, signedName: name, ip: String(q.ip || '').slice(0, 64), userAgent: String(q.headers['user-agent'] || '').slice(0, 255), signedAt: new Date() } as any); }
  catch (x: any) { if (x?.name === 'SequelizeUniqueConstraintError') throw bad('You have already signed this version', 409); throw x; }
  await completeTask(e.id, 'onboarding', 'handbook', q.user.id); await log(q.user.id, 'Handbook E-signed', `employee #${e.id} v${C.HANDBOOK_VERSION}`); s.status(201).json({ ok: true, version: C.HANDBOOK_VERSION });
}));
lifecycleRouter.put('/onboarding/:id/emergency-contact', wrap(async (q, s) => {
  const eid = id(q.params.id), who = await access(q.user, eid); if (who === 'manager') throw bad('Not allowed for your role', 403); await employee(eid);
  const name = String(q.body.name || '').trim(), rel = String(q.body.relationship || '').trim(), phone = String(q.body.phone || '').trim();
  if (name.length < 2 || name.length > 120) throw bad('Contact name is required'); if (!rel || rel.length > 60) throw bad('Relationship is required'); if (!/^[0-9+()\-. ]{7,30}$/.test(phone)) throw bad('Enter a valid phone number');
  const [row] = await M.EmergencyContact.findOrCreate({ where: { employeeId: eid }, defaults: { name, relationship: rel, phone } as any }); await row.update({ name, relationship: rel, phone });
  await completeTask(eid, 'onboarding', 'emergency', q.user.id); await log(q.user.id, 'Emergency Contact Saved', `employee #${eid}`); s.json({ ok: true });
}));
/** P5: HR completes Section 2. "Within deadline? No -> create compliance task, escalate". */
lifecycleRouter.post('/onboarding/:id/i9-section2', hr, wrap(async (q, s) => {
  const eid = id(q.params.id), e = await employee(eid);
  if (eid === q.user.id) throw bad('You cannot complete Section 2 for yourself', 403);
  if (!(await M.SensitiveForm.findOne({ where: { employeeId: eid, form: 'i9_s1' }, attributes: ['id'] }))) throw bad('The employee has not completed Section 1 yet', 409);
  const v = C.validateI9S2({ firstDayOfEmployment: e.startDate, ...q.body }); if (!v.ok) throw invalid(v.errors);
  await saveForm(eid, 'i9_s2', { ...v.clean, completedLate: v.late, deadline: v.deadline, completedBy: q.user.id }, q.user.id); await completeTask(eid, 'onboarding', 'i9_s2', q.user.id);
  if (v.late) {
    await M.ComplianceTask.create({ employeeId: eid, type: `I-9 Section 2 completed late (due ${v.deadline})`, dueDate: C.todayStr(), status: 'open' } as any);
    await notify(await hrIds(), 'compliance', `Late I-9 Section 2: ${e.name}`, `Deadline was ${v.deadline}. A compliance task was created.`, 'employee', eid);
  }
  await log(q.user.id, v.late ? 'I-9 Section 2 Submitted (late)' : 'I-9 Section 2 Submitted', `employee #${eid}`); s.status(201).json({ ok: true, late: v.late, deadline: v.deadline });
}));
const SENSITIVE_FORMS = ['i9_s1', 'i9_s2', 'w4'] as const;
const mask = (d: any) => { const o = JSON.parse(JSON.stringify(d)); if (o.ssn) o.ssn = C.maskSsn(o.ssn); for (const k of ['alienNumber', 'i94Number', 'passportNumber']) if (o[k]) o[k] = '****' + String(o[k]).slice(-3); (o.documents || []).forEach((x: any) => { if (x.documentNumber) x.documentNumber = '****' + String(x.documentNumber).slice(-3); }); return o; };
/** HR/admin: decrypted view (every view is audited). Employee: their own data with identifiers masked. Managers: never. */
lifecycleRouter.get('/onboarding/:id/sensitive/:form', wrap(async (q, s) => {
  const eid = id(q.params.id), form = String(q.params.form) as any; if (!SENSITIVE_FORMS.includes(form)) throw bad('Unknown form', 404);
  const who = await access(q.user, eid); if (who === 'manager') throw bad('Not allowed for your role', 403);
  const row: any = await M.SensitiveForm.findOne({ where: { employeeId: eid, form } }); if (!row) throw bad('Not submitted yet', 404);
  let data: any; try { data = C.decryptJson(row.data, C.formAad(form, eid)); } catch { throw bad('Stored data cannot be read. Check DATA_ENCRYPTION_KEY.', 503); }
  if (who === 'hr') await log(q.user.id, 'Sensitive Data Viewed', `${form} employee #${eid}`);
  s.json({ form, completedAt: row.completedAt, masked: who !== 'hr', data: who === 'hr' ? data : mask(data) });
}));
/** Re-encrypt rows written with an old key (key rotation). Admin only. */
lifecycleRouter.post('/security/rotate-keys', hr, wrap(async (q, s) => {
  if (q.user.role !== 'admin') throw bad('Only an administrator can rotate keys', 403);
  let n = 0; for (const row of (await M.SensitiveForm.findAll()) as any[]) { if (!C.needsRotation(row.data)) continue; const aad = C.formAad(row.form, row.employeeId); await row.update({ data: C.encryptJson(C.decryptJson(row.data, aad), aad) }); n++; }
  await log(q.user.id, 'Encryption Keys Rotated', `${n} rows`); s.json({ rotated: n });
}));

// ---------------------------------------------------------------- P5 assign manager and equipment, chase
lifecycleRouter.post('/onboarding/:id/assign', hr, wrap(async (q, s) => {
  const eid = id(q.params.id), e = await employee(eid), mid = id(q.body.managerId); if (mid === eid) throw bad('A person cannot manage themselves');
  const m: any = await M.Employee.findByPk(mid); if (!m || m.status === 'terminated' || !['manager', 'hr', 'admin'].includes(m.role)) throw bad('Choose an active manager');
  if ((await teamOf(eid)).includes(mid)) throw bad('That would create a reporting loop');
  const items: any[] = Array.isArray(q.body.equipment) ? q.body.equipment.slice(0, 20) : [];
  for (const it of items) if (!String(it?.item || '').trim() || String(it.item).length > 120 || String(it.assetTag || '').length > 60) throw bad('Each equipment line needs an item name (max 120) and an optional tag (max 60)');
  await e.update({ managerId: mid });
  for (const it of items) await M.Asset.create({ employeeId: eid, item: String(it.item).trim(), assetTag: String(it.assetTag || '').trim() || null, status: 'assigned', assignedAt: C.todayStr() } as any);
  await completeTask(eid, 'onboarding', 'assign', q.user.id, `Manager ${m.name}; ${items.length} item(s)`);
  await notify([mid], 'onboarding', `New team member: ${e.name}`, 'Please acknowledge and plan their first week.', 'employee', eid); await notify([eid], 'onboarding', 'Your manager and equipment are assigned', `Manager: ${m.name}.`, 'employee', eid);
  await log(q.user.id, 'Manager and Equipment Assigned', `employee #${eid} manager #${mid} items ${items.length}`); s.json({ ok: true });
}));
lifecycleRouter.post('/onboarding/:id/chase', hr, wrap(async (q, s) => {
  const eid = id(q.params.id), e = await employee(eid); const open: any[] = await M.LifecycleTask.findAll({ where: { employeeId: eid, kind: 'onboarding', status: 'open' }, raw: true });
  if (!open.length) throw bad('There are no pending items', 409);
  const hrs = await hrIds(); let sent = 0;
  for (const [role, users] of [['employee', [eid]], ['manager', [e.managerId]], ['hr', hrs]] as [string, (number | null)[]][]) {
    const t = open.filter((x) => x.ownerRole === role); if (!t.length) continue; await notify(users, 'reminder', `Pending onboarding items for ${e.name}`, t.map((x) => x.title).join('; '), 'employee', eid); sent++;
  }
  await log(q.user.id, 'Onboarding Chased', `employee #${eid} ${open.length} items`); s.json({ ok: true, pending: open.length, notified: sent });
}));

// ---------------------------------------------------------------- generic task completion (manual tasks only)
lifecycleRouter.post('/lifecycle/tasks/:id/complete', wrap(async (q, s) => {
  const t: any = await M.LifecycleTask.findByPk(id(q.params.id)); if (!t) throw bad('Not found', 404);
  if (t.status !== 'open') throw bad('This task is not open', 409);
  if (t.auto) throw bad('This task completes automatically when its form or action is done', 409);
  const note = String(q.body.note || '').trim().slice(0, 500);
  if (t.ownerRole === 'hr') { if (!isHR(q.user)) throw bad('Not allowed for your role', 403); if (t.employeeId === q.user.id) throw bad('You cannot complete tasks about yourself', 403); }
  else if (t.ownerRole === 'manager') { if (t.employeeId === q.user.id) throw bad('You cannot complete tasks about yourself', 403); if (!isHR(q.user) && !(q.user.role === 'manager' && (await teamOf(q.user.id)).includes(t.employeeId))) throw bad('Not allowed for your role', 403); }
  else if (t.employeeId !== q.user.id) throw bad('Not allowed for your role', 403);
  if (t.kind === 'offboarding' && !(await M.Offboarding.findOne({ where: { employeeId: t.employeeId, status: 'in_progress' } }))) throw bad('Offboarding is not in progress', 409);
  if (t.key === 'w4_verify' && !(await M.SensitiveForm.findOne({ where: { employeeId: t.employeeId, form: 'w4' }, attributes: ['id'] }))) throw bad('The W-4 has not been submitted yet', 409);
  if (t.key === 'collect_assets') { const n = await M.Asset.count({ where: { employeeId: t.employeeId, status: 'assigned' } }); if (n) throw bad(`${n} asset(s) are still assigned. Mark each as returned or missing first.`, 409); }
  if (['final_pay', 'benefits_notice'].includes(t.key) && note.length < 3) throw bad('Add a note (for example the pay sheet period or the date and method the notice was sent)');
  await completeTask(t.employeeId, t.kind, t.key, q.user.id, note); await log(q.user.id, 'Lifecycle Task Done', `#${t.id} ${t.kind}/${t.key} employee #${t.employeeId}`);
  s.json(await M.LifecycleTask.findByPk(t.id));
}));

// ---------------------------------------------------------------- assets (P5 equipment, P8 return checklist)
lifecycleRouter.get('/assets', wrap(async (q, s) => { const eid = id(q.query.employeeId); await access(q.user, eid); s.json(await M.Asset.findAll({ where: { employeeId: eid }, order: [['id', 'ASC']] })); }));
lifecycleRouter.post('/assets', hr, wrap(async (q, s) => {
  const eid = id(q.body.employeeId); await employee(eid); const item = String(q.body.item || '').trim(), tag = String(q.body.assetTag || '').trim();
  if (!item || item.length > 120 || tag.length > 60) throw bad('Item name is required (max 120 characters)');
  const a = await M.Asset.create({ employeeId: eid, item, assetTag: tag || null, status: 'assigned', assignedAt: C.todayStr() } as any); await log(q.user.id, 'Asset Assigned', `#${(a as any).id} employee #${eid}`); s.status(201).json(a);
}));
lifecycleRouter.post('/assets/:id/return', hr, wrap(async (q, s) => {
  const status = String(q.body.status || ''), note = String(q.body.note || '').trim().slice(0, 500); if (!['returned', 'missing'].includes(status)) throw bad('Status must be returned or missing'); if (status === 'missing' && note.length < 3) throw bad('Add a note explaining the missing item');
  const [n] = await M.Asset.update({ status, returnedAt: C.todayStr(), note: note || null } as any, { where: { id: id(q.params.id), status: 'assigned' } }); if (!n) throw bad('Asset not found or already closed', 409);
  await log(q.user.id, `Asset ${status === 'returned' ? 'Returned' : 'Marked Missing'}`, `#${q.params.id}`); s.json({ ok: true });
}));

// ---------------------------------------------------------------- P8 offboarding
const offView = (o: any, full: boolean) => ({ id: o.id, employeeId: o.employeeId, terminationDate: o.terminationDate, status: o.status, retentionUntil: o.retentionUntil, accessRevokedAt: o.accessRevokedAt, completedAt: o.completedAt, initiatedBy: o.initiatedBy, decisionNote: o.decisionNote, ...(full ? { reason: o.reason, originalReason: o.originalReason, notes: o.notes, proposedBy: o.proposedBy, decidedBy: o.decidedBy } : {}) });
lifecycleRouter.post('/offboarding', hr, wrap(async (q, s) => {
  const eid = id(q.body.employeeId), e = await employee(eid), td = C.isoDate(q.body.terminationDate);
  if (eid === q.user.id) throw bad('You cannot offboard yourself', 400); if (e.status === 'terminated') throw bad('This employee is already terminated', 409);
  if (!td) throw bad('Enter a valid termination date'); if (e.startDate && td < e.startDate) throw bad('Termination date cannot be before the start date');
  if (td < C.addDays(C.todayStr(), -60)) throw bad('Termination date cannot be more than 60 days in the past'); if (!C.TERMINATION_REASONS.includes(q.body.reason)) throw bad('Choose a termination reason');
  const notes = String(q.body.notes || '').slice(0, 2000);
  if (await M.Offboarding.findOne({ where: { employeeId: eid, status: { [Op.in]: ['proposed', 'in_progress'] } } })) throw bad('Offboarding is already in progress for this employee', 409);
  const o: any = await M.Offboarding.create({ employeeId: eid, terminationDate: td, reason: q.body.reason, originalReason: q.body.reason, notes, startedBy: q.user.id, initiatedBy: 'hr', decidedBy: q.user.id } as any);
  await startRun(o, e, q.user.id, 'Offboarding Started'); s.status(201).json(offView(await M.Offboarding.findByPk(o.id), true));
}));
/** Creates the checklist and notifies: used by HR starting directly and by HR approving a proposal (S6: employee/manager propose, HR approves). */
async function startRun(o: any, e: any, actor: number, action: string) {
  await M.LifecycleTask.destroy({ where: { employeeId: o.employeeId, kind: 'offboarding' } });             // a previous cancelled run
  for (const t of C.buildChecklist('offboarding', o.terminationDate)) await M.LifecycleTask.create({ employeeId: o.employeeId, kind: 'offboarding', key: t.key, title: t.title, ownerRole: t.ownerRole, team: t.team, mandatory: t.mandatory, auto: t.auto, dueDate: t.dueDate } as any);
  await log(actor, action, `#${o.id} employee #${o.employeeId} on ${o.terminationDate}`);   // the reason is restricted and stays out of the audit text
  await notify([e.managerId], 'offboarding', `Offboarding: ${e.name}`, `Please hand over work and tasks before ${o.terminationDate}.`, 'offboarding', o.id); await notify(await hrIds(), 'offboarding', `Offboarding started: ${e.name}`, `Termination date ${o.terminationDate}.`, 'offboarding', o.id);
  await sweepLifecycle();
}
const OPEN_OFF = ['proposed', 'in_progress'];
// S6 first lane: the EMPLOYEE submits a resignation, or the MANAGER documents a proposed separation. Nothing starts until HR approves.
lifecycleRouter.post('/offboarding/propose', wrap(async (q, s) => {
  const u = q.user, target = q.body.employeeId ? id(q.body.employeeId) : u.id, e = await employee(target), td = C.isoDate(q.body.terminationDate);
  const self = target === u.id; let initiatedBy = 'employee', reason = 'resignation';
  if (!self) {
    if (u.role !== 'manager' || !(await teamOf(u.id)).includes(target)) throw bad('You can only propose a separation for someone on your team', 403);
    if (!C.TERMINATION_REASONS.includes(q.body.reason)) throw bad('Choose a separation reason code'); initiatedBy = 'manager'; reason = q.body.reason;
  }
  if (e.status === 'terminated') throw bad('This employee is already terminated', 409);
  if (!td) throw bad('Enter a valid last day'); if (td < C.todayStr()) throw bad('The last day cannot be in the past'); if (td > C.addDays(C.todayStr(), 180)) throw bad('The last day is too far ahead (180 days maximum)');
  if (await M.Offboarding.findOne({ where: { employeeId: target, status: { [Op.in]: OPEN_OFF } } })) throw bad('A separation is already open for this employee', 409);
  const o: any = await M.Offboarding.create({ employeeId: target, terminationDate: td, reason, originalReason: reason, notes: String(q.body.notes || '').slice(0, 2000), status: 'proposed', initiatedBy, proposedBy: u.id } as any);
  await log(u.id, 'Separation Proposed', `#${o.id} employee #${target} by ${initiatedBy}`); await notify(await hrIds(), 'offboarding', `Separation proposed: ${e.name}`, `Last day ${td}. Review and approve or stop it.`, 'offboarding', o.id);
  s.status(201).json(offView(o, true));
}));
// HR / Legal / Leadership step: classify the reason accurately, approve or stop. Nobody decides their own.
lifecycleRouter.post('/offboarding/:id/decide', hr, wrap(async (q, s) => {
  const o: any = await M.Offboarding.findByPk(id(q.params.id)); if (!o) throw bad('Not found', 404);
  if (o.employeeId === q.user.id) throw bad('You cannot decide your own separation', 403); if (o.proposedBy === q.user.id) throw bad('Someone other than the proposer must decide', 403);
  const approve = !!q.body.approve, note = String(q.body.note || '').slice(0, 1000);
  if (!approve && !note) throw bad('A note is required when stopping a separation');
  let reason = o.reason; if (approve && q.body.reason !== undefined) { if (!C.TERMINATION_REASONS.includes(q.body.reason)) throw bad('Choose a valid reason code'); reason = q.body.reason; }
  const [n] = await M.Offboarding.update({ status: approve ? 'in_progress' : 'rejected', decidedBy: q.user.id, decisionNote: note || null, reason } as any, { where: { id: o.id, status: 'proposed' } });
  if (!n) throw bad('This separation is not waiting for a decision', 409);
  const e = await employee(o.employeeId);
  if (reason !== o.reason) await log(q.user.id, 'Separation Reclassified', `#${o.id} the HR-classified reason differs from the proposal`);
  if (approve) await startRun(await M.Offboarding.findByPk(o.id), e, q.user.id, 'Separation Approved');
  else await log(q.user.id, 'Separation Stopped', `#${o.id} ${note}`);
  await notify([o.proposedBy], 'offboarding', approve ? 'Separation approved' : 'Separation stopped', note || (approve ? 'HR approved the separation.' : ''), 'offboarding', o.id);
  s.json(offView(await M.Offboarding.findByPk(o.id), true));
}));
lifecycleRouter.get('/offboarding/mine', wrap(async (q, s) => {   // the employee sees the status of their own request, not the restricted details
  const rows: any[] = await M.Offboarding.findAll({ where: { employeeId: q.user.id }, order: [['id', 'DESC']], limit: 10 });
  s.json(rows.map((o) => ({ id: o.id, terminationDate: o.terminationDate, status: o.status, decisionNote: o.decisionNote })));
}));
lifecycleRouter.get('/offboarding', staff, wrap(async (q, s) => {
  await sweepLifecycle(); const ids = await scopeIds(q.user); const rows: any[] = await M.Offboarding.findAll({ where: inScope(ids), order: [['id', 'DESC']], limit: 100 });
  const tasks: any[] = await M.LifecycleTask.findAll({ where: { kind: 'offboarding', employeeId: { [Op.in]: rows.map((r) => r.employeeId) } }, raw: true });
  const emps: any[] = await M.Employee.findAll({ where: { id: { [Op.in]: rows.map((r) => r.employeeId) } }, attributes: ['id', 'name', 'title', 'department'], raw: true });
  s.json(rows.map((o) => { const t = tasks.filter((x) => x.employeeId === o.employeeId && x.status !== 'cancelled'); return { ...offView(o, isHR(q.user)), employee: emps.find((e) => e.id === o.employeeId), total: t.length, done: t.filter((x) => x.status === 'done').length }; }));
}));
lifecycleRouter.get('/offboarding/:id', staff, wrap(async (q, s) => {
  await sweepLifecycle(); const o: any = await M.Offboarding.findByPk(id(q.params.id)); if (!o) throw bad('Not found', 404); await access(q.user, o.employeeId); const e = await employee(o.employeeId);
  s.json({ ...offView(o, isHR(q.user)), employee: publicEmp(e), suggestedRetention: C.defaultRetentionUntil(e.startDate || o.terminationDate, o.terminationDate),
    tasks: await M.LifecycleTask.findAll({ where: { employeeId: o.employeeId, kind: 'offboarding' }, order: [['id', 'ASC']] }), assets: await M.Asset.findAll({ where: { employeeId: o.employeeId }, order: [['id', 'ASC']] }) });
}));
lifecycleRouter.post('/offboarding/:id/retention', hr, wrap(async (q, s) => {
  const o: any = await M.Offboarding.findByPk(id(q.params.id)); if (!o) throw bad('Not found', 404); if (o.status !== 'in_progress') throw bad('Offboarding is not in progress', 409);
  const e = await employee(o.employeeId), d = C.isoDate(q.body.retentionUntil), min = C.defaultRetentionUntil(e.startDate || o.terminationDate, o.terminationDate);
  if (!d) throw bad('Enter a valid date'); if (d < min) throw bad(`Retention cannot end before ${min} (later of I-9 and payroll record rules)`);
  await o.update({ retentionUntil: d }); await completeTask(o.employeeId, 'offboarding', 'retention', q.user.id, `Retain until ${d}`); await log(q.user.id, 'Retention Date Set', `#${o.id} ${d}`); s.json(offView(await M.Offboarding.findByPk(o.id), true));
}));
lifecycleRouter.post('/offboarding/:id/cancel', hr, wrap(async (q, s) => {
  const o: any = await M.Offboarding.findByPk(id(q.params.id)); if (!o) throw bad('Not found', 404);
  if (o.status !== 'in_progress') throw bad('Offboarding is not in progress', 409); if (o.accessRevokedAt) throw bad('Access was already revoked. This cannot be cancelled.', 409);
  await o.update({ status: 'cancelled' }); await M.LifecycleTask.update({ status: 'cancelled' } as any, { where: { employeeId: o.employeeId, kind: 'offboarding', status: 'open' } });
  await log(q.user.id, 'Offboarding Cancelled', `#${o.id} employee #${o.employeeId}`); s.json({ ok: true });
}));
// ---- final pay review (S6 / P8): totals + what HR must review. State rules come from versioned compliance rules, never from a national default.
async function finalPayFor(o: any) {
  const e: any = await employee(o.employeeId);
  const sheets: any[] = await M.Timesheet.findAll({ where: { employeeId: e.id, status: 'approved', payrollStatus: { [Op.in]: ['none', 'ready'] } }, raw: true });   // approved but not yet in a locked/exported payroll
  const sum = (k: string) => sheets.reduce((a, x) => a + Number(x[k]), 0);
  const bal: any[] = await M.LeaveBalance.findAll({ where: { employeeId: e.id }, raw: true });
  const unused = (t: string) => Math.max(0, bal.filter((b) => b.type === t).reduce((a, b) => a + Number(b.total) - Number(b.used) - Number(b.pending), 0));
  const bonuses: any[] = await M.Bonus.findAll({ where: { employeeId: e.id, status: 'approved' }, raw: true });
  const lines: any[] = await M.CommissionLine.findAll({ where: { employeeId: e.id, status: 'approved' }, raw: true });
  const state = String(e.workState || '').toUpperCase();
  const rule: any = H.ruleAt((await M.ComplianceRule.findAll({ raw: true })) as any, 'final_pay', [state, 'US'].filter(Boolean), o.terminationDate);
  const res = finalPay({ payType: e.payType, hourlyRateCents: Math.round(Number(e.hourlyRate || 0) * 100), annualSalaryCents: Math.round(Number(e.annualSalary || 0) * 100),
    unpaid: { regularHours: sum('regularHours'), otHours: sum('otHours'), dtHours: sum('dtHours') }, leave: { annualHours: unused('Annual'), sickHours: unused('Sick') },
    pendingBonusCents: bonuses.reduce((a, b) => a + Number(b.amountCents), 0), pendingCommissionCents: lines.reduce((a, l) => a + Number(l.payableCents), 0), state,
    rule: rule ? { ...rule.value, verified: !!rule.verified } : null });
  return { offboardingId: o.id, employee: { id: e.id, name: e.name, state }, terminationDate: o.terminationDate, rule: rule ? { jurisdiction: rule.jurisdiction, version: rule.version, effectiveDate: rule.effectiveDate, verified: rule.verified } : null,
    unpaidTimesheets: sheets.length, leave: { annualHoursUnused: unused('Annual'), sickHoursUnused: unused('Sick') }, ...res };
}
lifecycleRouter.get('/offboarding/:id/final-pay', hr, wrap(async (q, s) => {
  const o: any = await M.Offboarding.findByPk(id(q.params.id)); if (!o) throw bad('Not found', 404); s.json(await finalPayFor(o));
}));
lifecycleRouter.post('/offboarding/:id/final-pay/confirm', hr, wrap(async (q, s) => {
  const o: any = await M.Offboarding.findByPk(id(q.params.id)); if (!o) throw bad('Not found', 404);
  if (o.employeeId === q.user.id) throw bad('You cannot confirm your own final pay', 403); if (o.status !== 'in_progress') throw bad('Offboarding is not in progress', 409);
  const r = await finalPayFor(o), note = String(q.body.note || '').trim();
  if (r.needsReview.length && note.length < 10) throw bad('Explain how each review item was resolved (at least 10 characters)');
  await completeTask(o.employeeId, 'offboarding', 'final_pay', q.user.id, note ? 'Reviewed: ' + note.slice(0, 200) : 'No review items');
  await log(q.user.id, 'Final Pay Confirmed', `#${o.id} employee #${o.employeeId} review items:${r.needsReview.length}`); s.json({ ok: true, needsReview: r.needsReview });
}));
/** "Status Terminated -> Offboarding complete": needs all mandatory tasks done AND access revoked (termination date reached). */
async function maybeFinishOffboarding(employeeId: number) {
  const o: any = await M.Offboarding.findOne({ where: { employeeId, status: 'in_progress' } }); if (!o || !o.accessRevokedAt) return;
  if (await M.LifecycleTask.count({ where: { employeeId, kind: 'offboarding', mandatory: true, status: 'open' } })) return;
  const [n] = await M.Offboarding.update({ status: 'complete', completedAt: new Date() } as any, { where: { id: o.id, status: 'in_progress' } }); if (!n) return;
  await M.Employee.update({ status: 'terminated' }, { where: { id: employeeId } }); await log(0, 'Offboarding Complete', `#${o.id} employee #${employeeId}`);
  await notify(await hrIds(), 'offboarding', 'Offboarding complete', `Employee #${employeeId} is now Terminated. Retention until ${o.retentionUntil}.`, 'offboarding', o.id);
}

// ---------------------------------------------------------------- scheduled sweep: overdue escalation + access revocation
export async function sweepLifecycle(now = new Date()) {
  const today = C.todayStr(now); let escalated = 0, revoked = 0;
  for (const t of (await M.LifecycleTask.findAll({ where: { status: 'open', dueDate: { [Op.lt]: today }, escalatedAt: null } })) as any[]) {
    const [n] = await M.LifecycleTask.update({ escalatedAt: now } as any, { where: { id: t.id, escalatedAt: null } }); if (!n) continue;
    const e: any = await M.Employee.findByPk(t.employeeId, { attributes: ['id', 'name', 'managerId'] });
    await M.ComplianceTask.create({ employeeId: t.employeeId, type: `Overdue ${t.kind} task: ${t.title}`, dueDate: t.dueDate, status: 'overdue' } as any);
    await notify([t.ownerRole === 'employee' ? t.employeeId : t.ownerRole === 'manager' ? e?.managerId : null, ...(await hrIds())], 'escalation', `Overdue: ${t.title}`, `${e?.name ?? 'Employee'}, due ${t.dueDate}`, 'employee', t.employeeId);
    await log(0, 'Task Escalated', `#${t.id} ${t.kind}/${t.key}`); escalated++;
  }
  for (const o of (await M.Offboarding.findAll({ where: { status: 'in_progress', accessRevokedAt: null, terminationDate: { [Op.lte]: today } } })) as any[]) {
    const at = new Date(Math.floor(now.getTime() / 1000) * 1000);                                   // whole seconds: MySQL DATETIME rounds, and a rounded-up value would not be "in the past" yet
    const [n] = await M.Offboarding.update({ accessRevokedAt: at } as any, { where: { id: o.id, accessRevokedAt: null } }); if (!n) continue;
    await M.Employee.update({ accessRevokedAt: at } as any, { where: { id: o.employeeId } });                     // login disabled, sessions rejected on the next request
    await completeTask(o.employeeId, 'offboarding', 'revoke_access', null, 'Revoked automatically on the termination date'); await log(0, 'Access Revoked', `employee #${o.employeeId}`); revoked++;
  }
  for (const o of (await M.Offboarding.findAll({ where: { status: 'in_progress', accessRevokedAt: { [Op.ne]: null } } })) as any[]) await maybeFinishOffboarding(o.employeeId);
  return { escalated, revoked };
}

// ---------------------------------------------------------------- P7 credentials
const credView = (c: any, names: Map<number, string>, today: string) => { const left = c.expiryDate ? C.daysUntil(c.expiryDate, today) : null;
  return { ...c, employeeName: names.get(c.employeeId), daysLeft: left, bucket: left === null || !['verified', 'expired'].includes(c.status) ? null : C.credentialBucket(left) }; };
const nameMap = async (ids: number[]) => new Map(((await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids)] } }, attributes: ['id', 'name'], raw: true })) as any[]).map((x) => [x.id, x.name]));
lifecycleRouter.get('/credentials', wrap(async (q, s) => {
  const rows: any[] = await M.Credential.findAll({ where: { status: { [Op.ne]: 'superseded' }, ...inScope(await scopeIds(q.user)) }, order: [['expiryDate', 'ASC']], limit: 300, raw: true }); const n = await nameMap(rows.map((r) => r.employeeId)); const t = C.todayStr();
  s.json(rows.map((r) => credView(r, n, t)));
}));
/** Dashboard: Compliant / Expiring soon / Expired (plus pending and rejected). */
lifecycleRouter.get('/credentials/summary', wrap(async (q, s) => {
  const rows: any[] = await M.Credential.findAll({ where: { status: { [Op.ne]: 'superseded' }, ...inScope(await scopeIds(q.user)) }, raw: true }); const t = C.todayStr();
  const out: any = { compliant: 0, expiring_soon: 0, expired: 0, pending: 0, rejected: 0, flaggedEmployees: [] as number[] };
  for (const r of rows) { if (r.status === 'pending' || r.status === 'rejected') { out[r.status]++; continue; } const b = r.status === 'expired' ? 'expired' : C.credentialBucket(C.daysUntil(r.expiryDate, t)); out[b]++; if (b === 'expired' && !out.flaggedEmployees.includes(r.employeeId)) out.flaggedEmployees.push(r.employeeId); }
  const n = await nameMap(out.flaggedEmployees); out.flaggedEmployees = out.flaggedEmployees.map((i: number) => ({ id: i, name: n.get(i) })); s.json(out);
}));
const credFields = (b: any, today = C.todayStr()) => {
  const issued = b.issuedDate ? C.isoDate(b.issuedDate) : null, expiry = C.isoDate(b.expiryDate), ref = String(b.documentRef || '').trim();
  if (b.issuedDate && !issued) throw bad('Issue date is not valid'); if (!expiry) throw bad('Expiry date is required'); if (issued && issued > expiry) throw bad('Expiry date cannot be before the issue date');
  if (expiry > C.addYears(today, 50)) throw bad('Expiry date is too far in the future'); if (ref.length < 3 || ref.length > 500 || /[\u0000-\u001f]/.test(ref)) throw bad('Add a document reference (file name or link, 3-500 characters)');
  return { issuedDate: issued, expiryDate: expiry, documentRef: ref };
};
lifecycleRouter.post('/credentials', wrap(async (q, s) => {
  const eid = q.body.employeeId ? id(q.body.employeeId) : q.user.id; if (eid !== q.user.id && !isHR(q.user)) throw bad('You can only add your own credentials', 403); const e = await employee(eid);
  if (!C.CREDENTIAL_TYPES.includes(q.body.type)) throw bad('Choose a credential type'); const name = String(q.body.name || '').trim(), issuer = String(q.body.issuer || '').trim(); if (!name || name.length > 160 || issuer.length > 160) throw bad('Credential name is required (max 160 characters)');
  const c: any = await M.Credential.create({ employeeId: eid, type: q.body.type, name, issuer: issuer || null, ...credFields(q.body), status: 'pending' } as any);
  await notify(await hrIds(), 'credential', `Credential to verify: ${name}`, `${e.name} uploaded a credential.`, 'credential', c.id); await log(q.user.id, 'Credential Uploaded', `#${c.id} employee #${eid}`); s.status(201).json(c);
}));
lifecycleRouter.post('/credentials/:id/renew', wrap(async (q, s) => {
  const old: any = await M.Credential.findByPk(id(q.params.id)); if (!old) throw bad('Not found', 404); if (old.employeeId !== q.user.id && !isHR(q.user)) throw bad('Not allowed for your role', 403);
  if (!['verified', 'expired'].includes(old.status)) throw bad('Only a verified or expired credential can be renewed', 409);
  if (await M.Credential.findOne({ where: { renewsId: old.id, status: 'pending' } })) throw bad('A renewal is already waiting for verification', 409);
  const f = credFields(q.body); if (f.expiryDate <= old.expiryDate) throw bad('The renewal must expire after the current credential');
  const c: any = await M.Credential.create({ employeeId: old.employeeId, type: old.type, name: old.name, issuer: old.issuer, ...f, status: 'pending', renewsId: old.id } as any);
  await notify(await hrIds(), 'credential', `Renewal to verify: ${old.name}`, 'A renewal was uploaded.', 'credential', c.id); await log(q.user.id, 'Credential Renewal Uploaded', `#${c.id} renews #${old.id}`); s.status(201).json(c);
}));
lifecycleRouter.post('/credentials/:id/verify', hr, wrap(async (q, s) => {
  const c: any = await M.Credential.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); if (c.employeeId === q.user.id) throw bad('You cannot verify your own credential', 403);
  const approve = q.body.approve === true, reason = String(q.body.reason || '').trim().slice(0, 500); if (!approve && reason.length < 3) throw bad('A reason is required when rejecting');
  if (approve && c.expiryDate <= C.todayStr()) throw bad('This credential has already expired. Ask for a valid one.');
  const [n] = await M.Credential.update(approve ? { status: 'verified', verifiedBy: q.user.id, verifiedAt: new Date(), rejectionReason: null } as any : { status: 'rejected', verifiedBy: q.user.id, verifiedAt: new Date(), rejectionReason: reason } as any, { where: { id: c.id, status: 'pending' } });
  if (!n) throw bad('This credential is no longer pending', 409);
  if (approve && c.renewsId) await M.Credential.update({ status: 'superseded' } as any, { where: { id: c.renewsId } });
  await log(q.user.id, approve ? 'Credential Verified' : 'Credential Rejected', `#${c.id} employee #${c.employeeId}`);
  if (!approve) await notify([c.employeeId], 'credential', `Credential rejected: ${c.name}`, reason, 'credential', c.id); else await runCredentialReminders(new Date(), c.id);
  s.json(await M.Credential.findByPk(c.id));
}));
lifecycleRouter.post('/credentials/run-reminders', hr, wrap(async (q, s) => { const r = await runCredentialReminders(); await log(q.user.id, 'Credential Reminders Run', `${r.reminders.length} reminders, ${r.expired.length} expired`); s.json(r); }));
lifecycleRouter.post('/lifecycle/sweep', hr, wrap(async (q, s) => { const a = await sweepLifecycle(), b = await runCredentialReminders(); await log(q.user.id, 'Lifecycle Sweep Run', JSON.stringify({ ...a, reminders: b.reminders.length, expired: b.expired.length })); s.json({ ...a, ...b }); }));

/**
 * P7 daily job. Reminder at 90, 60, 30 and 7 days before expiry (each sent once, to employee + manager + HR).
 * On/after expiry: status Expired, compliance task created and employee flagged (once). Safe to run repeatedly: every state change is a conditional update.
 */
export async function runCredentialReminders(now = new Date(), onlyId?: number) {
  const today = C.todayStr(now); const out = { checked: 0, reminders: [] as { id: number; threshold: number }[], expired: [] as number[] };
  const rows: any[] = await M.Credential.findAll({ where: { status: 'verified', ...(onlyId ? { id: onlyId } : {}) } });
  for (const c of rows) {
    out.checked++; const left = C.daysUntil(c.expiryDate, today); const e: any = await M.Employee.findByPk(c.employeeId, { attributes: ['id', 'name', 'managerId', 'status'] }); if (!e || e.status === 'terminated') continue;
    const recipients = [e.id, e.managerId, ...(await hrIds())];
    if (left <= 0) {
      const [n] = await M.Credential.update({ status: 'expired', expiredHandledAt: now } as any, { where: { id: c.id, status: 'verified' } }); if (!n) continue;
      await M.ComplianceTask.create({ employeeId: e.id, type: `Credential expired: ${c.name}`, dueDate: today, status: 'overdue' } as any);
      await notify(recipients, 'credential', `Credential expired: ${c.name}`, `${e.name}'s credential expired on ${c.expiryDate}. Upload a renewal.`, 'credential', c.id); await log(0, 'Credential Expired', `#${c.id} employee #${e.id}`); out.expired.push(c.id); continue;
    }
    const t = C.reminderThreshold(left, c.lastReminderDays); if (t === null) continue;
    const [n] = await M.Credential.update({ lastReminderDays: t } as any, { where: { id: c.id, status: 'verified', [Op.or]: [{ lastReminderDays: null }, { lastReminderDays: { [Op.gt]: t } }] } }); if (!n) continue;
    await notify(recipients, 'credential', `${c.name} expires in ${left} day${left === 1 ? '' : 's'}`, `${e.name}: expires ${c.expiryDate} (${t}-day reminder).`, 'credential', c.id);
    await log(0, 'Credential Reminder', `#${c.id} ${t}d`); out.reminders.push({ id: c.id, threshold: t });
  }
  return out;
}
