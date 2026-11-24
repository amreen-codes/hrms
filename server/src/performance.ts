/** S5 evaluation, performance improvement and progressive warnings. Fair-process controls: facts and evidence, employee response, consistency review, maker-checker, HR/legal review before any termination step. */
import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import { log, isHR, teamOf, scopeIds, inScope } from './services';
import { wrap, bad, hr, staff } from './http';
import * as H from './hrCore';
import { isoDate, todayStr, addDays } from './lifecycleCore';

export const performanceRouter = Router();
const id = (v: any) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id'); return n; };
const txt = (v: any, max: number) => String(v ?? '').trim().slice(0, max);
const ping = (userId: number | null | undefined, title: string, body: string) => userId ? M.Notification.create({ userId, kind: 'performance', title, body: body.slice(0, 1000), entityType: 'performance', entityId: 0 } as any).catch(() => null) : null;
const hrIds = async () => ((await M.Employee.findAll({ where: { role: { [Op.in]: ['hr', 'admin'] }, status: { [Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })) as any[]).map((x) => x.id);
const nameMap = async (ids: number[]) => new Map(((await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids.filter(Boolean))] } }, attributes: ['id', 'name'], raw: true })) as any[]).map((x) => [x.id, x.name]));
/** HR for anyone, a manager for their own team; never about yourself. */
async function mayManage(u: any, eid: number) { if (eid === u.id) throw bad('You cannot do this for yourself', 403); if (!(isHR(u) || (u.role === 'manager' && (await teamOf(u.id)).includes(eid)))) throw bad('You can only do this for your own team', 403); const e: any = await M.Employee.findByPk(eid); if (!e || e.status === 'terminated') throw bad('Employee not found', 404); return e; }
/** Employees see only their own delivered/issued records; managers their team; HR everyone. */
const mineOnly = (u: any) => !isHR(u) && u.role !== 'manager';

// ---- goals (set measurable expectations; employee acknowledges)
performanceRouter.get('/performance/goals', wrap(async (q, s) => { const rows: any[] = await M.GoalSet.findAll({ where: inScope(await scopeIds(q.user)), order: [['employeeId', 'ASC'], ['version', 'DESC']], limit: 300, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId)); s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId) }))); }));
performanceRouter.post('/performance/goals', staff, wrap(async (q, s) => {
  const eid = id(q.body.employeeId); const e = await mayManage(q.user, eid), rd = isoDate(q.body.reviewDate), goals = Array.isArray(q.body.goals) ? q.body.goals : [];
  if (!rd || rd <= todayStr()) throw bad('Set a future review date'); if (!goals.length || goals.length > 15) throw bad('Add 1 to 15 goals');
  const clean = goals.map((g: any) => { if (!txt(g.title, 200) || !txt(g.target, 200)) throw bad('Every goal needs a title and a measurable target'); return { title: txt(g.title, 200), kpi: txt(g.kpi, 200), target: txt(g.target, 200), baseline: txt(g.baseline, 200) }; });
  const last: any = await M.GoalSet.findOne({ where: { employeeId: eid }, order: [['version', 'DESC']] }), g: any = await M.GoalSet.create({ employeeId: eid, version: (last?.version || 0) + 1, goals: clean, reviewDate: rd, setBy: q.user.id } as any);
  await ping(eid, 'New goals and expectations', `Version ${g.version}, review on ${rd}. Please acknowledge them.`); await log(q.user.id, 'Goals Set', `employee #${eid} v${g.version}`); s.status(201).json(g);
}));
performanceRouter.post('/performance/goals/:id/ack', wrap(async (q, s) => { const [n] = await M.GoalSet.update({ acknowledgedAt: new Date() } as any, { where: { id: id(q.params.id), employeeId: q.user.id, acknowledgedAt: null } }); if (!n) throw bad('Not found or already acknowledged', 404); await log(q.user.id, 'Goals Acknowledged', `#${q.params.id}`); s.json({ ok: true }); }));

// ---- evaluations (draft -> delivered -> acknowledged; acknowledgement is not agreement)
performanceRouter.get('/performance/evaluations', wrap(async (q, s) => {
  const where: any = { ...inScope(await scopeIds(q.user)), ...(mineOnly(q.user) ? { status: { [Op.ne]: 'draft' } } : {}) };
  const rows: any[] = await M.Evaluation.findAll({ where, order: [['id', 'DESC']], limit: 300, raw: true }); const nm = await nameMap(rows.flatMap((r) => [r.employeeId, r.reviewerId]));
  s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId), reviewerName: nm.get(r.reviewerId), ...(r.employeeId === q.user.id && r.reviewerId !== q.user.id ? { conductNote: undefined } : {}) })));
}));
performanceRouter.post('/performance/evaluations', staff, wrap(async (q, s) => {
  const eid = id(q.body.employeeId); await mayManage(q.user, eid); const ps = isoDate(q.body.periodStart), pe = isoDate(q.body.periodEnd), b = q.body;
  if (!ps || !pe || pe < ps) throw bad('Choose the review period'); if (!['scheduled', 'event'].includes(b.kind)) throw bad('Kind: scheduled or event'); if (!(Number.isInteger(b.score) && b.score >= 1 && b.score <= 5)) throw bad('Score must be 1 to 5');
  for (const k of ['strengths', 'gaps', 'expectations']) if (txt(b[k], 5000).length < 10) throw bad(`${k} needs at least 10 characters of facts and examples`);
  const evidence = (Array.isArray(b.evidence) ? b.evidence : []).map((x: any) => ({ source: txt(x.source, 200), date: txt(x.date, 10), note: txt(x.note, 1000) })).filter((x: any) => x.source && x.note);
  if (b.improvementNeeded && !evidence.length) throw bad('Improvement needed: attach the factual examples (dates, outputs, records) behind it');
  const ev: any = await M.Evaluation.create({ employeeId: eid, reviewerId: q.user.id, periodStart: ps, periodEnd: pe, kind: b.kind, score: b.score, strengths: txt(b.strengths, 5000), gaps: txt(b.gaps, 5000), expectations: txt(b.expectations, 5000), conductNote: txt(b.conductNote, 5000) || null, improvementNeeded: !!b.improvementNeeded, evidence } as any);
  await log(q.user.id, 'Evaluation Drafted', `#${ev.id} employee #${eid}`); s.status(201).json(ev);
}));
performanceRouter.post('/performance/evaluations/:id/deliver', staff, wrap(async (q, s) => {
  const ev: any = await M.Evaluation.findByPk(id(q.params.id)); if (!ev) throw bad('Not found', 404); if (ev.reviewerId !== q.user.id && !isHR(q.user)) throw bad('Only the reviewer or HR can deliver this evaluation', 403);
  const [n] = await M.Evaluation.update({ status: 'delivered', deliveredAt: new Date() } as any, { where: { id: ev.id, status: 'draft' } }); if (!n) throw bad('Already delivered', 409);
  await ping(ev.employeeId, 'Your performance evaluation is ready', 'Review it and add your response.'); await log(q.user.id, 'Evaluation Delivered', `#${ev.id}`); s.json({ ok: true });
}));
performanceRouter.post('/performance/evaluations/:id/ack', wrap(async (q, s) => {
  const [n] = await M.Evaluation.update({ status: 'acknowledged', acknowledgedAt: new Date(), employeeResponse: txt(q.body.response, 5000) || null } as any, { where: { id: id(q.params.id), employeeId: q.user.id, status: 'delivered' } });
  if (!n) throw bad('Nothing to acknowledge', 404); await log(q.user.id, 'Evaluation Acknowledged', `#${q.params.id} (acknowledgement is not agreement)`); s.json({ ok: true });
}));

// ---- warnings: first written -> second -> final. Second/final need a consistency review and HR approval.
const COUNTED = ['issued', 'acknowledged', 'refused'];
performanceRouter.get('/performance/warnings', wrap(async (q, s) => {
  const where: any = { ...inScope(await scopeIds(q.user)), ...(mineOnly(q.user) ? { status: { [Op.in]: COUNTED } } : {}) };
  const rows: any[] = await M.Warning.findAll({ where, order: [['id', 'DESC']], limit: 300, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId)); s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId) })));
}));
const levelsOf = async (eid: number) => ((await M.Warning.findAll({ where: { employeeId: eid, status: { [Op.in]: COUNTED } }, order: [['id', 'ASC']], raw: true })) as any[]).map((w) => w.level as H.WarningLevel);
performanceRouter.post('/performance/warnings', staff, wrap(async (q, s) => {
  const eid = id(q.body.employeeId); await mayManage(q.user, eid); const b = q.body;
  if (await M.Warning.findOne({ where: { employeeId: eid, status: 'pending_approval' } })) throw bad('A warning is already waiting for HR approval for this employee', 409);
  const missing = H.validateWarning({ issue: b.issue, standard: b.standard, support: b.support, timeline: b.timeline, consequences: b.consequences }); if (missing.length) throw bad(missing.join('; '));
  const level = H.nextWarningLevel(await levelsOf(eid)); if (!level) throw bad('A final warning is already on file: review the outcome through the improvement plan', 409);
  const rd = isoDate(b.reviewDeadline); if (!rd || rd <= todayStr()) throw bad('Set a future review deadline'); if (!txt(b.policyVersion, 30)) throw bad('Record the policy version this warning applies');
  const consistency = txt(b.consistencyNote, 3000); if (level !== 'first_written' && consistency.length < 10) throw bad('Second and final warnings need a consistency review: how others were treated and any mitigating facts (at least 10 characters)');
  const direct = isHR(q.user) || level === 'first_written';
  const w: any = await M.Warning.create({ employeeId: eid, level, issue: txt(b.issue, 5000), standard: txt(b.standard, 5000), support: txt(b.support, 5000), timeline: txt(b.timeline, 2000), consequences: txt(b.consequences, 2000), policyVersion: txt(b.policyVersion, 30), consistencyNote: consistency || null,
    evaluationId: b.evaluationId ? id(b.evaluationId) : null, reviewDeadline: rd, status: direct ? 'issued' : 'pending_approval', authoredBy: q.user.id, approvedBy: direct ? q.user.id : null, issuedAt: direct ? new Date() : null } as any);
  if (direct) await ping(eid, 'You have received a written warning', `${level.replace('_', ' ')}: please read and acknowledge it.`); else for (const h of await hrIds()) await ping(h, 'Warning awaiting your approval', `Employee #${eid}: ${level}`);
  await log(q.user.id, direct ? 'Warning Issued' : 'Warning Proposed', `#${w.id} employee #${eid} ${level}`); s.status(201).json(w);
}));
performanceRouter.post('/performance/warnings/:id/approve', hr, wrap(async (q, s) => {
  const w: any = await M.Warning.findByPk(id(q.params.id)); if (!w) throw bad('Not found', 404); if (w.employeeId === q.user.id) throw bad('You cannot decide a warning about yourself', 403); if (w.authoredBy === q.user.id) throw bad('Someone other than the author must approve', 403);
  const approve = !!q.body.approve, note = txt(q.body.note, 1000); if (!approve && note.length < 5) throw bad('A note is required when declining a warning');
  const [n] = await M.Warning.update(approve ? { status: 'issued', approvedBy: q.user.id, issuedAt: new Date() } as any : { status: 'withdrawn', withdrawnNote: note, approvedBy: q.user.id } as any, { where: { id: w.id, status: 'pending_approval' } }); if (!n) throw bad('This warning is not waiting for approval', 409);
  if (approve) await ping(w.employeeId, 'You have received a written warning', `${w.level.replace('_', ' ')}: please read and acknowledge it.`); await ping(w.authoredBy, approve ? 'Warning approved' : 'Warning declined', note); await log(q.user.id, approve ? 'Warning Approved' : 'Warning Declined', `#${w.id}`); s.json({ ok: true });
}));
performanceRouter.post('/performance/warnings/:id/ack', wrap(async (q, s) => {
  const outcome = q.body.outcome; if (!['acknowledged', 'refused'].includes(outcome)) throw bad('Acknowledge it, or record that you refuse to sign');
  if (outcome === 'refused' && txt(q.body.witness, 200).length < 2) throw bad('Name the witness present when the employee refused to acknowledge');
  const [n] = await M.Warning.update({ status: outcome, ackNote: txt(q.body.response, 5000) || null, witness: txt(q.body.witness, 200) || null } as any, { where: { id: id(q.params.id), employeeId: q.user.id, status: 'issued' } }); if (!n) throw bad('Nothing to acknowledge', 404);
  await log(q.user.id, outcome === 'refused' ? 'Warning Refused' : 'Warning Acknowledged', `#${q.params.id} (acknowledgement is not agreement)`); s.json({ ok: true });
}));
performanceRouter.post('/performance/warnings/:id/withdraw', hr, wrap(async (q, s) => {
  const w: any = await M.Warning.findByPk(id(q.params.id)); if (!w) throw bad('Not found', 404); if (w.employeeId === q.user.id) throw bad('You cannot decide a warning about yourself', 403); const note = txt(q.body.note, 1000); if (note.length < 10) throw bad('Explain why it is withdrawn (at least 10 characters)');
  const [n] = await M.Warning.update({ status: 'withdrawn', withdrawnNote: note } as any, { where: { id: w.id, status: { [Op.in]: COUNTED } } }); if (!n) throw bad('This warning cannot be withdrawn', 409); await log(q.user.id, 'Warning Withdrawn', `#${w.id}`); s.json({ ok: true });
}));

// ---- performance improvement plan
performanceRouter.get('/performance/pips', wrap(async (q, s) => { const rows: any[] = await M.Pip.findAll({ where: inScope(await scopeIds(q.user)), order: [['id', 'DESC']], limit: 200, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId)); s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId), ...(mineOnly(q.user) ? { hrLegalNote: undefined, grievanceNote: undefined } : {}) }))); }));
performanceRouter.post('/performance/pips', staff, wrap(async (q, s) => {
  const eid = id(q.body.employeeId); await mayManage(q.user, eid); const sd = isoDate(q.body.startDate), ed = isoDate(q.body.endDate), goals = Array.isArray(q.body.goals) ? q.body.goals : [];
  if (!sd || !ed || ed < addDays(sd, 7) || ed > addDays(sd, 180)) throw bad('A plan runs between 7 and 180 days'); if (!goals.length) throw bad('Add the measurable goals'); if (txt(q.body.support, 3000).length < 10) throw bad('Describe the support and resources you will provide');
  if (await M.Pip.findOne({ where: { employeeId: eid, status: 'active' } })) throw bad('An improvement plan is already active', 409);
  if (q.body.warningId) { const w: any = await M.Warning.findByPk(id(q.body.warningId)); if (!w || w.employeeId !== eid) throw bad('That warning does not belong to this employee'); }
  const p: any = await M.Pip.create({ employeeId: eid, warningId: q.body.warningId || null, startDate: sd, endDate: ed, goals: goals.map((g: any) => ({ title: txt(g.title, 200), target: txt(g.target, 200) })), support: txt(q.body.support, 3000), createdBy: q.user.id } as any);
  await ping(eid, 'Performance improvement plan', `Runs ${sd} to ${ed}. Your manager will hold regular check-ins.`); await log(q.user.id, 'PIP Started', `#${p.id} employee #${eid}`); s.status(201).json(p);
}));
performanceRouter.post('/performance/pips/:id/checkin', staff, wrap(async (q, s) => {
  const p: any = await M.Pip.findByPk(id(q.params.id)); if (!p) throw bad('Not found', 404); await mayManage(q.user, p.employeeId); if (p.status !== 'active') throw bad('This plan is closed', 409);
  const progress = txt(q.body.progress, 3000), support = txt(q.body.support, 3000); if (progress.length < 10) throw bad('Record objective progress (at least 10 characters)'); if (!support) throw bad('Record the support or resources you provided');
  await p.update({ checkins: [...(p.checkins || []), { date: todayStr(), by: q.user.id, progress, support }] }); await log(q.user.id, 'PIP Check-in', `#${p.id}`); s.json(p);
}));
/** Final review by HR / leadership: success, extend with a reason, reassign/coach, or consider termination (only after the final warning, final review and HR/legal review). */
performanceRouter.post('/performance/pips/:id/outcome', hr, wrap(async (q, s) => {
  const p: any = await M.Pip.findByPk(id(q.params.id)); if (!p) throw bad('Not found', 404); if (p.employeeId === q.user.id) throw bad('You cannot decide your own plan', 403); if (p.status !== 'active') throw bad('This plan is closed', 409);
  const outcome = q.body.outcome, note = txt(q.body.note, 3000); if (!['success', 'extended', 'reassign_coach', 'termination_review'].includes(outcome)) throw bad('Choose an outcome'); if (note.length < 10) throw bad('Record the rationale (at least 10 characters)');
  const grievance = txt(q.body.grievanceNote, 1000) || 'Employee may use the company grievance route';
  if (outcome === 'extended') { const ne = isoDate(q.body.newEndDate); if (!ne || ne <= p.endDate) throw bad('Enter a new end date after the current one'); if (p.extensions >= 2) throw bad('A plan can be extended at most twice: choose another outcome', 409);
    await p.update({ endDate: ne, extensions: p.extensions + 1, outcomeNote: note }); await log(q.user.id, 'PIP Extended', `#${p.id} to ${ne}`); return s.json(p); }
  if (outcome === 'termination_review') {
    const ok = H.mayConsiderTermination({ issued: await levelsOf(p.employeeId), finalReviewDone: !!q.body.finalReviewDone, hrLegalReviewed: !!q.body.hrLegalReviewed });
    if (!ok) throw bad('Termination can only be considered after a final warning, the final review and the HR/legal review (protected leave, accommodation, retaliation and consistency checks)', 409);
    if (txt(q.body.hrLegalNote, 3000).length < 10) throw bad('Record the HR/legal review (at least 10 characters)');
    if (await M.Offboarding.findOne({ where: { employeeId: p.employeeId, status: { [Op.in]: ['proposed', 'in_progress'] } } })) throw bad('A separation is already open for this employee', 409);
    await M.Offboarding.create({ employeeId: p.employeeId, terminationDate: addDays(todayStr(), 14), reason: 'performance', originalReason: 'performance', notes: 'Proposed after the improvement plan final review. Another HR user must approve (S6).', status: 'proposed', initiatedBy: 'hr', proposedBy: q.user.id } as any);
    await p.update({ status: 'closed_termination_review', outcomeNote: note, finalReviewDone: true, hrLegalReviewed: true, hrLegalNote: txt(q.body.hrLegalNote, 3000), grievanceNote: grievance, decidedBy: q.user.id });
    await log(q.user.id, 'PIP Termination Review', `#${p.id} separation proposed for approval`); return s.json(p);
  }
  await p.update({ status: outcome === 'success' ? 'closed_success' : 'closed_reassign', outcomeNote: note, grievanceNote: grievance, decidedBy: q.user.id }); await ping(p.employeeId, 'Improvement plan outcome', outcome === 'success' ? 'Your plan was closed successfully.' : 'Your plan was closed. Your manager will follow up.'); await log(q.user.id, outcome === 'success' ? 'PIP Closed Successfully' : 'PIP Closed Reassign/Coach', `#${p.id}`); s.json(p);
}));
