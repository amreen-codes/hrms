/** BPMN P3: tasks are created automatically from rules set per company and location, tracked to completion, escalated when overdue, and can be escalated, resolved or waived with a reason (audited). */
import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import { log } from './services';
import { wrap, bad, hr } from './http';
import * as H from './hrCore';
import { todayStr, addDays } from './lifecycleCore';

export const complianceFlowRouter = Router();
const txt = (v: any, max: number) => String(v ?? '').trim().slice(0, max);
const ping = (userId: number | null | undefined, title: string, body: string) => userId ? M.Notification.create({ userId, kind: 'compliance', title, body: body.slice(0, 1000), entityType: 'compliance', entityId: 0 } as any).catch(() => null) : null;
const hrAdminIds = async (roles = ['hr', 'admin']) => ((await M.Employee.findAll({ where: { role: { [Op.in]: roles }, status: { [Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })) as any[]).map((x) => x.id);
const jurs = (e: any) => { const st = String(e.workState || '').toUpperCase(), city = String(e.profile?.city || '').trim(); return [city && st ? `${st}:${city}` : '', st, 'US'].filter(Boolean); };

/** Rule keys beginning with task_ are compliance task rules, e.g. task_handbook {type, trigger: 'hire' | 'annual', dueDays, retentionYears}. */
export async function generateComplianceTasks() {
  const rules: any[] = await M.ComplianceRule.findAll({ raw: true }), keys = [...new Set(rules.filter((r) => String(r.key).startsWith('task_')).map((r) => r.key))] as string[];
  const t = todayStr(), year = t.slice(0, 4); let created = 0;
  for (const e of (await M.Employee.findAll({ where: { status: { [Op.in]: ['active', 'onboarding'] } } })) as any[]) {
    for (const key of keys) {
      const rule: any = H.ruleAt(rules as any, key, jurs(e), t); if (!rule) continue;
      const v = rule.value || {}, periodKey = v.trigger === 'annual' ? `${key}:${year}` : key;
      if (await M.ComplianceTask.findOne({ where: { employeeId: e.id, periodKey } })) continue;
      const base = v.trigger === 'annual' ? t : (e.startDate || t), due = addDays(base, Number(v.dueDays) || 7);
      await M.ComplianceTask.create({ employeeId: e.id, ownerId: e.id, type: String(v.type || key), dueDate: due, status: due < t ? 'overdue' : 'open', locationKey: String(e.workState || 'US').toUpperCase(), ruleId: rule.id, source: 'rule', periodKey } as any);
      await ping(e.id, 'New compliance task', `${v.type || key}, due ${due}`); created++;
    }
  }
  return created;
}
export async function runComplianceJob() {
  const t = todayStr(), created = await generateComplianceTasks(); let overdue = 0, escalated = 0;
  await M.ComplianceTask.update({ status: 'overdue' } as any, { where: { status: 'open', dueDate: { [Op.lt]: t } } });
  const hrs = await hrAdminIds(), admins = await hrAdminIds(['admin']);
  for (const k of (await M.ComplianceTask.findAll({ where: { status: 'overdue' } })) as any[]) {
    const e: any = k.employeeId ? await M.Employee.findByPk(k.employeeId) : null;
    if (!k.overdueNotifiedAt) { await k.update({ overdueNotifiedAt: new Date() }); for (const u of new Set([k.ownerId || k.employeeId, e?.managerId, ...hrs].filter(Boolean))) await ping(u as number, 'Compliance task overdue', `${e?.name || ''}: ${k.type} was due ${k.dueDate}`); overdue++; }
    if (k.escalationLevel < 1 && k.dueDate < addDays(t, -7)) { await k.update({ escalationLevel: 1, escalatedAt: new Date() }); for (const u of admins) await ping(u, 'Compliance task escalated', `${e?.name || ''}: ${k.type} is more than 7 days overdue`); escalated++; }
  }
  return { created, overdue, escalated };
}
complianceFlowRouter.post('/compliance/generate', hr, wrap(async (q, s) => { const created = await generateComplianceTasks(); await log(q.user.id, 'Compliance Tasks Generated', `created:${created}`); s.json({ created }); }));
/** Dashboard: open, due soon and overdue, by task type and location. */
complianceFlowRouter.get('/compliance/dashboard', hr, wrap(async (_q, s) => {
  const t = todayStr(), soon = addDays(t, 7), rows: any[] = await M.ComplianceTask.findAll({ raw: true }), emps = new Map(((await M.Employee.findAll({ attributes: ['id', 'workState'], raw: true })) as any[]).map((e) => [e.id, e.workState]));
  const g = new Map<string, any>();
  for (const r of rows) {
    const loc = String(r.locationKey || emps.get(r.employeeId) || 'US').toUpperCase(), k = `${r.type}|${loc}`, x = g.get(k) || { type: r.type, location: loc, open: 0, dueSoon: 0, overdue: 0, done: 0, waived: 0 };
    if (r.status === 'done') x.done++; else if (r.status === 'waived') x.waived++; else if (r.status === 'overdue' || r.dueDate < t) x.overdue++; else { x.open++; if (r.dueDate <= soon) x.dueSoon++; }
    g.set(k, x);
  }
  s.json([...g.values()].sort((a, b) => b.overdue - a.overdue || a.type.localeCompare(b.type)));
}));
complianceFlowRouter.post('/compliance/:id/escalate', hr, wrap(async (q, s) => {
  const k: any = await M.ComplianceTask.findByPk(Number(q.params.id)); if (!k) throw bad('Not found', 404); if (!['open', 'overdue'].includes(k.status)) throw bad('Only open or overdue tasks can be escalated', 409);
  const note = txt(q.body.note, 1000); if (note.length < 5) throw bad('A note is required'); if (k.escalationLevel >= 3) throw bad('This task is already at the highest escalation level', 409);
  const e: any = k.employeeId ? await M.Employee.findByPk(k.employeeId) : null; await k.update({ escalationLevel: k.escalationLevel + 1, escalatedAt: new Date() });
  for (const u of new Set([...(await hrAdminIds(['admin'])), e?.managerId].filter(Boolean))) await ping(u as number, 'Compliance task escalated', `${e?.name || ''}: ${k.type} (${note})`); await log(q.user.id, 'Compliance Task Escalated', `#${k.id} level ${k.escalationLevel + 1}: ${note.slice(0, 150)}`); s.json(await M.ComplianceTask.findByPk(k.id));
}));
/** Waiving a requirement needs a reason and is audited; never for your own task. */
complianceFlowRouter.post('/compliance/:id/waive', hr, wrap(async (q, s) => {
  const k: any = await M.ComplianceTask.findByPk(Number(q.params.id)); if (!k) throw bad('Not found', 404); if (k.employeeId === q.user.id) throw bad('You cannot waive your own compliance task', 403);
  const reason = txt(q.body.reason, 1000); if (reason.length < 10) throw bad('A reason is required (at least 10 characters)');
  const [n] = await M.ComplianceTask.update({ status: 'waived', waivedBy: q.user.id, waiveReason: reason } as any, { where: { id: k.id, status: { [Op.in]: ['open', 'overdue'] } } }); if (!n) throw bad('Only open or overdue tasks can be waived', 409);
  await log(q.user.id, 'Compliance Task Waived', `#${k.id} ${k.type}: ${reason.slice(0, 200)}`); s.json(await M.ComplianceTask.findByPk(k.id));
}));
