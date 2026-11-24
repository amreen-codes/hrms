/** S4 training tracking: courses, role-based assignments, completion evidence, reminders and manager competency review. */
import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import { log, isHR, teamOf, scopeIds, inScope } from './services';
import { wrap, bad, hr, staff } from './http';
import * as H from './hrCore';
import { isoDate, todayStr, addDays } from './lifecycleCore';

export const trainingRouter = Router();
const id = (v: any) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id'); return n; };
const txt = (v: any, max: number) => String(v ?? '').trim().slice(0, max);
const ping = (userId: number | null | undefined, title: string, body: string) => userId ? M.Notification.create({ userId, kind: 'training', title, body: body.slice(0, 1000), entityType: 'training', entityId: 0 } as any).catch(() => null) : null;
const names = async (ids: number[]) => new Map(((await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids.filter(Boolean))] } }, attributes: ['id', 'name', 'managerId'], raw: true })) as any[]).map((x) => [x.id, x]));
const addMonths = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const CATS = ['safety', 'compliance', 'role', 'orientation', 'other'], MODES = ['online', 'in_person', 'self_study'];

// ---- courses
trainingRouter.get('/courses', wrap(async (q, s) => s.json(await M.Course.findAll({ where: isHR(q.user) ? {} : { active: true }, order: [['title', 'ASC']] }))));
async function courseBody(b: any, partial = false, selfId?: number) {
  const o: any = {};
  if (!partial || b.title !== undefined) { if (!txt(b.title, 200)) throw bad('A course title is required'); o.title = txt(b.title, 200); }
  if (!partial || b.category !== undefined) { if (!CATS.includes(b.category)) throw bad('Choose a category'); o.category = b.category; }
  if (!partial || b.deliveryMethod !== undefined) { if (!MODES.includes(b.deliveryMethod)) throw bad('Choose a delivery method'); o.deliveryMethod = b.deliveryMethod; }
  if (!partial || b.version !== undefined) { if (!txt(b.version, 20)) throw bad('A course version is required'); o.version = txt(b.version, 20); }
  if (b.description !== undefined) o.description = txt(b.description, 5000);
  if (b.passScore !== undefined) { if (b.passScore !== null && !(Number.isInteger(b.passScore) && b.passScore >= 1 && b.passScore <= 100)) throw bad('Pass score must be 1-100'); o.passScore = b.passScore; }
  if (b.recurrenceMonths !== undefined) { if (b.recurrenceMonths !== null && !(Number.isInteger(b.recurrenceMonths) && b.recurrenceMonths >= 1 && b.recurrenceMonths <= 60)) throw bad('Recurrence must be 1-60 months'); o.recurrenceMonths = b.recurrenceMonths; }
  if (b.prerequisiteId !== undefined && b.prerequisiteId !== null) { const pre: any = await M.Course.findByPk(id(b.prerequisiteId)); if (!pre) throw bad('Prerequisite course not found', 404); if (selfId && pre.id === selfId) throw bad('A course cannot be its own prerequisite'); o.prerequisiteId = pre.id; } else if (b.prerequisiteId === null) o.prerequisiteId = null;
  return o;
}
trainingRouter.post('/courses', hr, wrap(async (q, s) => { const c: any = await M.Course.create({ ...(await courseBody(q.body)), createdBy: q.user.id } as any); await log(q.user.id, 'Course Created', `#${c.id} ${c.title} v${c.version}`); s.status(201).json(c); }));
trainingRouter.patch('/courses/:id', hr, wrap(async (q, s) => {
  const c: any = await M.Course.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); const o = await courseBody(q.body, true, c.id); if (q.body.active !== undefined) o.active = !!q.body.active;
  await c.update(o); await log(q.user.id, 'Course Updated', `#${c.id} v${c.version} (existing assignments keep the version they were assigned)`); s.json(c);
}));

// ---- assignments
const mayAssign = async (u: any, eid: number) => isHR(u) || (u.role === 'manager' && (await teamOf(u.id)).includes(eid));
const status = (a: any, today = todayStr()) => H.trainingStatus({ dueDate: a.dueDate, startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : null, completedAt: a.completedAt ? new Date(a.completedAt).toISOString() : null, today });
trainingRouter.post('/training/assign', staff, wrap(async (q, s) => {
  const course: any = await M.Course.findByPk(id(q.body.courseId)); if (!course || !course.active) throw bad('Course not found or retired', 404);
  const due = isoDate(q.body.dueDate); if (!due || due < todayStr()) throw bad('Choose a due date that is not in the past');
  const ids: number[] = Array.isArray(q.body.employeeIds) ? q.body.employeeIds.map(Number) : []; if (!ids.length || ids.length > 100 || ids.some((n) => !Number.isInteger(n) || n <= 0)) throw bad('Choose 1 to 100 employees');
  const out = { assigned: 0, skipped: [] as string[] };
  for (const eid of [...new Set(ids)]) {
    const e: any = await M.Employee.findByPk(eid); if (!e || e.status === 'terminated') { out.skipped.push(`#${eid}: not found`); continue; }
    if (eid === q.user.id) { out.skipped.push(`${e.name}: you cannot assign training to yourself`); continue; }
    if (!(await mayAssign(q.user, eid))) { out.skipped.push(`${e.name}: not on your team`); continue; }
    if (await M.CourseAssignment.findOne({ where: { courseId: course.id, employeeId: eid, completedAt: null } })) { out.skipped.push(`${e.name}: already assigned`); continue; }
    await M.CourseAssignment.create({ courseId: course.id, employeeId: eid, courseVersion: course.version, assignedBy: q.user.id, dueDate: due } as any); out.assigned++;
    await ping(eid, 'New training assigned', `${course.title} (due ${due})`);
  }
  await log(q.user.id, 'Training Assigned', `course #${course.id} assigned:${out.assigned}`); s.status(201).json(out);
}));
trainingRouter.get('/training', wrap(async (q, s) => {
  const rows: any[] = await M.CourseAssignment.findAll({ where: inScope(await scopeIds(q.user)), order: [['dueDate', 'ASC']], limit: 500 });
  const cs = new Map(((await M.Course.findAll({ raw: true })) as any[]).map((c) => [c.id, c])), nm = await names(rows.map((r) => r.employeeId)), t = todayStr();
  s.json(rows.map((a) => ({ ...a.toJSON(), status: status(a, t), courseTitle: cs.get(a.courseId)?.title, passScore: cs.get(a.courseId)?.passScore, employeeName: nm.get(a.employeeId)?.name })));
}));
trainingRouter.get('/training/compliance', hr, wrap(async (_q, s) => {
  const rows: any[] = await M.CourseAssignment.findAll({ raw: true }), cs: any[] = await M.Course.findAll({ raw: true }), t = todayStr();
  s.json(cs.map((c) => { const mine = rows.filter((r) => r.courseId === c.id).map((r) => status(r, t)); const n = (k: string) => mine.filter((x) => x === k).length; return { courseId: c.id, title: c.title, assigned: n('assigned'), inProgress: n('in_progress'), completed: n('completed'), overdue: n('overdue'), total: mine.length }; }));
}));
async function mine(q: any) { const a: any = await M.CourseAssignment.findOne({ where: { id: id(q.params.id), employeeId: q.user.id } }); if (!a) throw bad('Not found', 404); return a; }
async function prereqDone(a: any) { const c: any = await M.Course.findByPk(a.courseId); if (c?.prerequisiteId && !(await M.CourseAssignment.findOne({ where: { employeeId: a.employeeId, courseId: c.prerequisiteId, completedAt: { [Op.ne]: null } } }))) { const p: any = await M.Course.findByPk(c.prerequisiteId); throw bad(`Complete the prerequisite first: ${p?.title}`, 409); } return c; }
trainingRouter.post('/training/:id/start', wrap(async (q, s) => { const a = await mine(q); if (a.completedAt) throw bad('Already completed', 409); await prereqDone(a); if (!a.startedAt) await a.update({ startedAt: new Date() }); s.json({ ok: true }); }));
async function finish(a: any, c: any, completedOn: Date, by: number, extra: any) {
  const [n] = await M.CourseAssignment.update({ completedAt: completedOn, ...extra } as any, { where: { id: a.id, completedAt: null } }); if (!n) throw bad('Already completed', 409);
  if (c?.recurrenceMonths) { const next = addMonths(completedOn.toISOString().slice(0, 10), c.recurrenceMonths); await M.CourseAssignment.create({ courseId: a.courseId, employeeId: a.employeeId, courseVersion: c.version, assignedBy: null, dueDate: next, recurredFromId: a.id } as any); }
  const emp: any = await M.Employee.findByPk(a.employeeId); await ping(emp?.managerId, 'Training completed', `${emp?.name}: ${c?.title}`); await log(by, 'Training Completed', `assignment #${a.id} course #${a.courseId}`);
}
trainingRouter.post('/training/:id/complete', wrap(async (q, s) => {
  const a = await mine(q); if (a.completedAt) throw bad('Already completed', 409); const c = await prereqDone(a);
  if (q.body.acknowledged !== true) throw bad('Acknowledge that you completed the training');
  let score: number | null = null;
  if (c.passScore) { score = Number(q.body.score); if (!Number.isFinite(score) || score < 0 || score > 100) throw bad('Enter your assessment score (0-100)'); await a.update({ attempts: a.attempts + 1, startedAt: a.startedAt || new Date() });                    // a.attempts is now the updated count
    if (score < c.passScore) return s.json({ passed: false, attempts: a.attempts, message: `Score ${score} is below the pass mark of ${c.passScore}. You can try again.` }); }
  await finish(a, c, new Date(), q.user.id, { score, certificateRef: txt(q.body.certificateRef, 300) || null, attempts: a.attempts, startedAt: a.startedAt || new Date() }); s.json({ passed: true });
}));
/** In-person / external training: HR records the completion with a reason. */
trainingRouter.post('/training/:id/record', hr, wrap(async (q, s) => {
  const a: any = await M.CourseAssignment.findByPk(id(q.params.id)); if (!a) throw bad('Not found', 404); if (a.completedAt) throw bad('Already completed', 409);
  if (a.employeeId === q.user.id) throw bad('You cannot record your own completion', 403); const on = isoDate(q.body.completedOn), note = txt(q.body.note, 500);
  if (!on || on > todayStr()) throw bad('Enter the completion date (not in the future)'); if (note.length < 5) throw bad('Say how the completion was verified (sign-in sheet, certificate...)');
  const c: any = await prereqDone(a), score = q.body.score == null ? null : Number(q.body.score); if (c.passScore && (score == null || score < c.passScore)) throw bad(`This course has a pass mark of ${c.passScore}: enter a passing score`);
  await finish(a, c, new Date(on + 'T12:00:00Z'), q.user.id, { score, certificateRef: note, recordedBy: q.user.id, startedAt: a.startedAt || new Date() }); s.json({ ok: true });
}));

// ---- manager competency review (probation / initial review)
trainingRouter.post('/training/competency', staff, wrap(async (q, s) => {
  const eid = id(q.body.employeeId); if (eid === q.user.id) throw bad('You cannot review your own competency', 403); if (!(await mayAssign(q.user, eid))) throw bad('You can only review your own team', 403);
  const outcome = q.body.outcome, notes = txt(q.body.notes, 5000), fu = q.body.followUpDate ? isoDate(q.body.followUpDate) : null;
  if (!['approved', 'coaching', 'retraining'].includes(outcome)) throw bad('Outcome: approved, coaching or retraining'); if (notes.length < 10) throw bad('Record the observed evidence (at least 10 characters)');
  if (outcome !== 'approved' && !fu) throw bad('Coaching or retraining needs a follow-up date'); if (fu && fu < todayStr()) throw bad('The follow-up date cannot be in the past');
  const r: any = await M.CompetencyReview.create({ employeeId: eid, reviewerId: q.user.id, notes, outcome, followUpDate: fu } as any); await ping(eid, 'Competency review recorded', `Outcome: ${outcome}`);
  await log(q.user.id, 'Competency Review', `employee #${eid} ${outcome}`); s.status(201).json(r);
}));
trainingRouter.get('/training/competency', wrap(async (q, s) => { const rows: any[] = await M.CompetencyReview.findAll({ where: inScope(await scopeIds(q.user)), order: [['id', 'DESC']], limit: 200, raw: true }); const nm = await names(rows.map((r) => r.employeeId)); s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId)?.name }))); }));

export async function runTrainingJob() {
  const t = todayStr(); let reminded = 0, overdue = 0; const hrs = (await M.Employee.findAll({ where: { role: { [Op.in]: ['hr', 'admin'] }, status: { [Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })) as any[];
  for (const a of (await M.CourseAssignment.findAll({ where: { completedAt: null } })) as any[]) {
    const e: any = await M.Employee.findByPk(a.employeeId), c: any = await M.Course.findByPk(a.courseId); if (!e || e.status === 'terminated') continue;
    if (a.dueDate < t && !a.overdueNotifiedAt) { await a.update({ overdueNotifiedAt: new Date() }); for (const u of new Set([e.id, e.managerId, ...hrs.map((h) => h.id)].filter(Boolean))) await ping(u as number, 'Training overdue', `${e.name}: ${c?.title} was due ${a.dueDate}`); overdue++; }
    else if (a.dueDate >= t && a.dueDate <= addDays(t, 3) && !a.remindedAt) { await a.update({ remindedAt: new Date() }); for (const u of new Set([e.id, e.managerId].filter(Boolean))) await ping(u as number, 'Training due soon', `${e.name}: ${c?.title} is due ${a.dueDate}`); reminded++; }
  }
  return { reminded, overdue };
}
