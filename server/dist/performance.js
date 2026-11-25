"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.performanceRouter = void 0;
/** S5 evaluation, performance improvement and progressive warnings. Fair-process controls: facts and evidence, employee response, consistency review, maker-checker, HR/legal review before any termination step. */
const express_1 = require("express");
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
const H = __importStar(require("./hrCore"));
const lifecycleCore_1 = require("./lifecycleCore");
exports.performanceRouter = (0, express_1.Router)();
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0)
    throw (0, http_1.bad)('Invalid id'); return n; };
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const ping = (userId, title, body) => userId ? M.Notification.create({ userId, kind: 'performance', title, body: body.slice(0, 1000), entityType: 'performance', entityId: 0 }).catch(() => null) : null;
const hrIds = async () => (await M.Employee.findAll({ where: { role: { [sequelize_1.Op.in]: ['hr', 'admin'] }, status: { [sequelize_1.Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })).map((x) => x.id);
const nameMap = async (ids) => new Map((await M.Employee.findAll({ where: { id: { [sequelize_1.Op.in]: [...new Set(ids.filter(Boolean))] } }, attributes: ['id', 'name'], raw: true })).map((x) => [x.id, x.name]));
/** HR for anyone, a manager for their own team; never about yourself. */
async function mayManage(u, eid) { if (eid === u.id)
    throw (0, http_1.bad)('You cannot do this for yourself', 403); if (!((0, services_1.isHR)(u) || (u.role === 'manager' && (await (0, services_1.teamOf)(u.id)).includes(eid))))
    throw (0, http_1.bad)('You can only do this for your own team', 403); const e = await M.Employee.findByPk(eid); if (!e || e.status === 'terminated')
    throw (0, http_1.bad)('Employee not found', 404); return e; }
/** Employees see only their own delivered/issued records; managers their team; HR everyone. */
const mineOnly = (u) => !(0, services_1.isHR)(u) && u.role !== 'manager';
// ---- goals (set measurable expectations; employee acknowledges)
exports.performanceRouter.get('/performance/goals', (0, http_1.wrap)(async (q, s) => { const rows = await M.GoalSet.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['employeeId', 'ASC'], ['version', 'DESC']], limit: 300, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId)); s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId) }))); }));
exports.performanceRouter.post('/performance/goals', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const eid = id(q.body.employeeId);
    const e = await mayManage(q.user, eid), rd = (0, lifecycleCore_1.isoDate)(q.body.reviewDate), goals = Array.isArray(q.body.goals) ? q.body.goals : [];
    if (!rd || rd <= (0, lifecycleCore_1.todayStr)())
        throw (0, http_1.bad)('Set a future review date');
    if (!goals.length || goals.length > 15)
        throw (0, http_1.bad)('Add 1 to 15 goals');
    const clean = goals.map((g) => { if (!txt(g.title, 200) || !txt(g.target, 200))
        throw (0, http_1.bad)('Every goal needs a title and a measurable target'); return { title: txt(g.title, 200), kpi: txt(g.kpi, 200), target: txt(g.target, 200), baseline: txt(g.baseline, 200) }; });
    const last = await M.GoalSet.findOne({ where: { employeeId: eid }, order: [['version', 'DESC']] }), g = await M.GoalSet.create({ employeeId: eid, version: (last?.version || 0) + 1, goals: clean, reviewDate: rd, setBy: q.user.id });
    await ping(eid, 'New goals and expectations', `Version ${g.version}, review on ${rd}. Please acknowledge them.`);
    await (0, services_1.log)(q.user.id, 'Goals Set', `employee #${eid} v${g.version}`);
    s.status(201).json(g);
}));
exports.performanceRouter.post('/performance/goals/:id/ack', (0, http_1.wrap)(async (q, s) => { const [n] = await M.GoalSet.update({ acknowledgedAt: new Date() }, { where: { id: id(q.params.id), employeeId: q.user.id, acknowledgedAt: null } }); if (!n)
    throw (0, http_1.bad)('Not found or already acknowledged', 404); await (0, services_1.log)(q.user.id, 'Goals Acknowledged', `#${q.params.id}`); s.json({ ok: true }); }));
// ---- evaluations (draft -> delivered -> acknowledged; acknowledgement is not agreement)
exports.performanceRouter.get('/performance/evaluations', (0, http_1.wrap)(async (q, s) => {
    const where = { ...(0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), ...(mineOnly(q.user) ? { status: { [sequelize_1.Op.ne]: 'draft' } } : {}) };
    const rows = await M.Evaluation.findAll({ where, order: [['id', 'DESC']], limit: 300, raw: true });
    const nm = await nameMap(rows.flatMap((r) => [r.employeeId, r.reviewerId]));
    s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId), reviewerName: nm.get(r.reviewerId), ...(r.employeeId === q.user.id && r.reviewerId !== q.user.id ? { conductNote: undefined } : {}) })));
}));
exports.performanceRouter.post('/performance/evaluations', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const eid = id(q.body.employeeId);
    await mayManage(q.user, eid);
    const ps = (0, lifecycleCore_1.isoDate)(q.body.periodStart), pe = (0, lifecycleCore_1.isoDate)(q.body.periodEnd), b = q.body;
    if (!ps || !pe || pe < ps)
        throw (0, http_1.bad)('Choose the review period');
    if (!['scheduled', 'event'].includes(b.kind))
        throw (0, http_1.bad)('Kind: scheduled or event');
    if (!(Number.isInteger(b.score) && b.score >= 1 && b.score <= 5))
        throw (0, http_1.bad)('Score must be 1 to 5');
    for (const k of ['strengths', 'gaps', 'expectations'])
        if (txt(b[k], 5000).length < 10)
            throw (0, http_1.bad)(`${k} needs at least 10 characters of facts and examples`);
    const evidence = (Array.isArray(b.evidence) ? b.evidence : []).map((x) => ({ source: txt(x.source, 200), date: txt(x.date, 10), note: txt(x.note, 1000) })).filter((x) => x.source && x.note);
    if (b.improvementNeeded && !evidence.length)
        throw (0, http_1.bad)('Improvement needed: attach the factual examples (dates, outputs, records) behind it');
    const ev = await M.Evaluation.create({ employeeId: eid, reviewerId: q.user.id, periodStart: ps, periodEnd: pe, kind: b.kind, score: b.score, strengths: txt(b.strengths, 5000), gaps: txt(b.gaps, 5000), expectations: txt(b.expectations, 5000), conductNote: txt(b.conductNote, 5000) || null, improvementNeeded: !!b.improvementNeeded, evidence });
    await (0, services_1.log)(q.user.id, 'Evaluation Drafted', `#${ev.id} employee #${eid}`);
    s.status(201).json(ev);
}));
exports.performanceRouter.post('/performance/evaluations/:id/deliver', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const ev = await M.Evaluation.findByPk(id(q.params.id));
    if (!ev)
        throw (0, http_1.bad)('Not found', 404);
    if (ev.reviewerId !== q.user.id && !(0, services_1.isHR)(q.user))
        throw (0, http_1.bad)('Only the reviewer or HR can deliver this evaluation', 403);
    const [n] = await M.Evaluation.update({ status: 'delivered', deliveredAt: new Date() }, { where: { id: ev.id, status: 'draft' } });
    if (!n)
        throw (0, http_1.bad)('Already delivered', 409);
    await ping(ev.employeeId, 'Your performance evaluation is ready', 'Review it and add your response.');
    await (0, services_1.log)(q.user.id, 'Evaluation Delivered', `#${ev.id}`);
    s.json({ ok: true });
}));
exports.performanceRouter.post('/performance/evaluations/:id/ack', (0, http_1.wrap)(async (q, s) => {
    const [n] = await M.Evaluation.update({ status: 'acknowledged', acknowledgedAt: new Date(), employeeResponse: txt(q.body.response, 5000) || null }, { where: { id: id(q.params.id), employeeId: q.user.id, status: 'delivered' } });
    if (!n)
        throw (0, http_1.bad)('Nothing to acknowledge', 404);
    await (0, services_1.log)(q.user.id, 'Evaluation Acknowledged', `#${q.params.id} (acknowledgement is not agreement)`);
    s.json({ ok: true });
}));
// ---- warnings: first written -> second -> final. Second/final need a consistency review and HR approval.
const COUNTED = ['issued', 'acknowledged', 'refused'];
exports.performanceRouter.get('/performance/warnings', (0, http_1.wrap)(async (q, s) => {
    const where = { ...(0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), ...(mineOnly(q.user) ? { status: { [sequelize_1.Op.in]: COUNTED } } : {}) };
    const rows = await M.Warning.findAll({ where, order: [['id', 'DESC']], limit: 300, raw: true });
    const nm = await nameMap(rows.map((r) => r.employeeId));
    s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId) })));
}));
const levelsOf = async (eid) => (await M.Warning.findAll({ where: { employeeId: eid, status: { [sequelize_1.Op.in]: COUNTED } }, order: [['id', 'ASC']], raw: true })).map((w) => w.level);
exports.performanceRouter.post('/performance/warnings', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const eid = id(q.body.employeeId);
    await mayManage(q.user, eid);
    const b = q.body;
    if (await M.Warning.findOne({ where: { employeeId: eid, status: 'pending_approval' } }))
        throw (0, http_1.bad)('A warning is already waiting for HR approval for this employee', 409);
    const missing = H.validateWarning({ issue: b.issue, standard: b.standard, support: b.support, timeline: b.timeline, consequences: b.consequences });
    if (missing.length)
        throw (0, http_1.bad)(missing.join('; '));
    const level = H.nextWarningLevel(await levelsOf(eid));
    if (!level)
        throw (0, http_1.bad)('A final warning is already on file: review the outcome through the improvement plan', 409);
    const rd = (0, lifecycleCore_1.isoDate)(b.reviewDeadline);
    if (!rd || rd <= (0, lifecycleCore_1.todayStr)())
        throw (0, http_1.bad)('Set a future review deadline');
    if (!txt(b.policyVersion, 30))
        throw (0, http_1.bad)('Record the policy version this warning applies');
    const consistency = txt(b.consistencyNote, 3000);
    if (level !== 'first_written' && consistency.length < 10)
        throw (0, http_1.bad)('Second and final warnings need a consistency review: how others were treated and any mitigating facts (at least 10 characters)');
    const direct = (0, services_1.isHR)(q.user) || level === 'first_written';
    const w = await M.Warning.create({ employeeId: eid, level, issue: txt(b.issue, 5000), standard: txt(b.standard, 5000), support: txt(b.support, 5000), timeline: txt(b.timeline, 2000), consequences: txt(b.consequences, 2000), policyVersion: txt(b.policyVersion, 30), consistencyNote: consistency || null,
        evaluationId: b.evaluationId ? id(b.evaluationId) : null, reviewDeadline: rd, status: direct ? 'issued' : 'pending_approval', authoredBy: q.user.id, approvedBy: direct ? q.user.id : null, issuedAt: direct ? new Date() : null });
    if (direct)
        await ping(eid, 'You have received a written warning', `${level.replace('_', ' ')}: please read and acknowledge it.`);
    else
        for (const h of await hrIds())
            await ping(h, 'Warning awaiting your approval', `Employee #${eid}: ${level}`);
    await (0, services_1.log)(q.user.id, direct ? 'Warning Issued' : 'Warning Proposed', `#${w.id} employee #${eid} ${level}`);
    s.status(201).json(w);
}));
exports.performanceRouter.post('/performance/warnings/:id/approve', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const w = await M.Warning.findByPk(id(q.params.id));
    if (!w)
        throw (0, http_1.bad)('Not found', 404);
    if (w.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot decide a warning about yourself', 403);
    if (w.authoredBy === q.user.id)
        throw (0, http_1.bad)('Someone other than the author must approve', 403);
    const approve = !!q.body.approve, note = txt(q.body.note, 1000);
    if (!approve && note.length < 5)
        throw (0, http_1.bad)('A note is required when declining a warning');
    const [n] = await M.Warning.update(approve ? { status: 'issued', approvedBy: q.user.id, issuedAt: new Date() } : { status: 'withdrawn', withdrawnNote: note, approvedBy: q.user.id }, { where: { id: w.id, status: 'pending_approval' } });
    if (!n)
        throw (0, http_1.bad)('This warning is not waiting for approval', 409);
    if (approve)
        await ping(w.employeeId, 'You have received a written warning', `${w.level.replace('_', ' ')}: please read and acknowledge it.`);
    await ping(w.authoredBy, approve ? 'Warning approved' : 'Warning declined', note);
    await (0, services_1.log)(q.user.id, approve ? 'Warning Approved' : 'Warning Declined', `#${w.id}`);
    s.json({ ok: true });
}));
exports.performanceRouter.post('/performance/warnings/:id/ack', (0, http_1.wrap)(async (q, s) => {
    const outcome = q.body.outcome;
    if (!['acknowledged', 'refused'].includes(outcome))
        throw (0, http_1.bad)('Acknowledge it, or record that you refuse to sign');
    if (outcome === 'refused' && txt(q.body.witness, 200).length < 2)
        throw (0, http_1.bad)('Name the witness present when the employee refused to acknowledge');
    const [n] = await M.Warning.update({ status: outcome, ackNote: txt(q.body.response, 5000) || null, witness: txt(q.body.witness, 200) || null }, { where: { id: id(q.params.id), employeeId: q.user.id, status: 'issued' } });
    if (!n)
        throw (0, http_1.bad)('Nothing to acknowledge', 404);
    await (0, services_1.log)(q.user.id, outcome === 'refused' ? 'Warning Refused' : 'Warning Acknowledged', `#${q.params.id} (acknowledgement is not agreement)`);
    s.json({ ok: true });
}));
exports.performanceRouter.post('/performance/warnings/:id/withdraw', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const w = await M.Warning.findByPk(id(q.params.id));
    if (!w)
        throw (0, http_1.bad)('Not found', 404);
    if (w.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot decide a warning about yourself', 403);
    const note = txt(q.body.note, 1000);
    if (note.length < 10)
        throw (0, http_1.bad)('Explain why it is withdrawn (at least 10 characters)');
    const [n] = await M.Warning.update({ status: 'withdrawn', withdrawnNote: note }, { where: { id: w.id, status: { [sequelize_1.Op.in]: COUNTED } } });
    if (!n)
        throw (0, http_1.bad)('This warning cannot be withdrawn', 409);
    await (0, services_1.log)(q.user.id, 'Warning Withdrawn', `#${w.id}`);
    s.json({ ok: true });
}));
// ---- performance improvement plan
exports.performanceRouter.get('/performance/pips', (0, http_1.wrap)(async (q, s) => { const rows = await M.Pip.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['id', 'DESC']], limit: 200, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId)); s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId), ...(mineOnly(q.user) ? { hrLegalNote: undefined, grievanceNote: undefined } : {}) }))); }));
exports.performanceRouter.post('/performance/pips', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const eid = id(q.body.employeeId);
    await mayManage(q.user, eid);
    const sd = (0, lifecycleCore_1.isoDate)(q.body.startDate), ed = (0, lifecycleCore_1.isoDate)(q.body.endDate), goals = Array.isArray(q.body.goals) ? q.body.goals : [];
    if (!sd || !ed || ed < (0, lifecycleCore_1.addDays)(sd, 7) || ed > (0, lifecycleCore_1.addDays)(sd, 180))
        throw (0, http_1.bad)('A plan runs between 7 and 180 days');
    if (!goals.length)
        throw (0, http_1.bad)('Add the measurable goals');
    if (txt(q.body.support, 3000).length < 10)
        throw (0, http_1.bad)('Describe the support and resources you will provide');
    if (await M.Pip.findOne({ where: { employeeId: eid, status: 'active' } }))
        throw (0, http_1.bad)('An improvement plan is already active', 409);
    if (q.body.warningId) {
        const w = await M.Warning.findByPk(id(q.body.warningId));
        if (!w || w.employeeId !== eid)
            throw (0, http_1.bad)('That warning does not belong to this employee');
    }
    const p = await M.Pip.create({ employeeId: eid, warningId: q.body.warningId || null, startDate: sd, endDate: ed, goals: goals.map((g) => ({ title: txt(g.title, 200), target: txt(g.target, 200) })), support: txt(q.body.support, 3000), createdBy: q.user.id });
    await ping(eid, 'Performance improvement plan', `Runs ${sd} to ${ed}. Your manager will hold regular check-ins.`);
    await (0, services_1.log)(q.user.id, 'PIP Started', `#${p.id} employee #${eid}`);
    s.status(201).json(p);
}));
exports.performanceRouter.post('/performance/pips/:id/checkin', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const p = await M.Pip.findByPk(id(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    await mayManage(q.user, p.employeeId);
    if (p.status !== 'active')
        throw (0, http_1.bad)('This plan is closed', 409);
    const progress = txt(q.body.progress, 3000), support = txt(q.body.support, 3000);
    if (progress.length < 10)
        throw (0, http_1.bad)('Record objective progress (at least 10 characters)');
    if (!support)
        throw (0, http_1.bad)('Record the support or resources you provided');
    await p.update({ checkins: [...(p.checkins || []), { date: (0, lifecycleCore_1.todayStr)(), by: q.user.id, progress, support }] });
    await (0, services_1.log)(q.user.id, 'PIP Check-in', `#${p.id}`);
    s.json(p);
}));
/** Final review by HR / leadership: success, extend with a reason, reassign/coach, or consider termination (only after the final warning, final review and HR/legal review). */
exports.performanceRouter.post('/performance/pips/:id/outcome', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const p = await M.Pip.findByPk(id(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    if (p.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot decide your own plan', 403);
    if (p.status !== 'active')
        throw (0, http_1.bad)('This plan is closed', 409);
    const outcome = q.body.outcome, note = txt(q.body.note, 3000);
    if (!['success', 'extended', 'reassign_coach', 'termination_review'].includes(outcome))
        throw (0, http_1.bad)('Choose an outcome');
    if (note.length < 10)
        throw (0, http_1.bad)('Record the rationale (at least 10 characters)');
    const grievance = txt(q.body.grievanceNote, 1000) || 'Employee may use the company grievance route';
    if (outcome === 'extended') {
        const ne = (0, lifecycleCore_1.isoDate)(q.body.newEndDate);
        if (!ne || ne <= p.endDate)
            throw (0, http_1.bad)('Enter a new end date after the current one');
        if (p.extensions >= 2)
            throw (0, http_1.bad)('A plan can be extended at most twice: choose another outcome', 409);
        await p.update({ endDate: ne, extensions: p.extensions + 1, outcomeNote: note });
        await (0, services_1.log)(q.user.id, 'PIP Extended', `#${p.id} to ${ne}`);
        return s.json(p);
    }
    if (outcome === 'termination_review') {
        const ok = H.mayConsiderTermination({ issued: await levelsOf(p.employeeId), finalReviewDone: !!q.body.finalReviewDone, hrLegalReviewed: !!q.body.hrLegalReviewed });
        if (!ok)
            throw (0, http_1.bad)('Termination can only be considered after a final warning, the final review and the HR/legal review (protected leave, accommodation, retaliation and consistency checks)', 409);
        if (txt(q.body.hrLegalNote, 3000).length < 10)
            throw (0, http_1.bad)('Record the HR/legal review (at least 10 characters)');
        if (await M.Offboarding.findOne({ where: { employeeId: p.employeeId, status: { [sequelize_1.Op.in]: ['proposed', 'in_progress'] } } }))
            throw (0, http_1.bad)('A separation is already open for this employee', 409);
        await M.Offboarding.create({ employeeId: p.employeeId, terminationDate: (0, lifecycleCore_1.addDays)((0, lifecycleCore_1.todayStr)(), 14), reason: 'performance', originalReason: 'performance', notes: 'Proposed after the improvement plan final review. Another HR user must approve (S6).', status: 'proposed', initiatedBy: 'hr', proposedBy: q.user.id });
        await p.update({ status: 'closed_termination_review', outcomeNote: note, finalReviewDone: true, hrLegalReviewed: true, hrLegalNote: txt(q.body.hrLegalNote, 3000), grievanceNote: grievance, decidedBy: q.user.id });
        await (0, services_1.log)(q.user.id, 'PIP Termination Review', `#${p.id} separation proposed for approval`);
        return s.json(p);
    }
    await p.update({ status: outcome === 'success' ? 'closed_success' : 'closed_reassign', outcomeNote: note, grievanceNote: grievance, decidedBy: q.user.id });
    await ping(p.employeeId, 'Improvement plan outcome', outcome === 'success' ? 'Your plan was closed successfully.' : 'Your plan was closed. Your manager will follow up.');
    await (0, services_1.log)(q.user.id, outcome === 'success' ? 'PIP Closed Successfully' : 'PIP Closed Reassign/Coach', `#${p.id}`);
    s.json(p);
}));
