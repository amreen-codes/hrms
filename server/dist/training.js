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
exports.trainingRouter = void 0;
exports.runTrainingJob = runTrainingJob;
/** S4 training tracking: courses, role-based assignments, completion evidence, reminders and manager competency review. */
const express_1 = require("express");
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
const H = __importStar(require("./hrCore"));
const lifecycleCore_1 = require("./lifecycleCore");
exports.trainingRouter = (0, express_1.Router)();
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0)
    throw (0, http_1.bad)('Invalid id'); return n; };
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const ping = (userId, title, body) => userId ? M.Notification.create({ userId, kind: 'training', title, body: body.slice(0, 1000), entityType: 'training', entityId: 0 }).catch(() => null) : null;
const names = async (ids) => new Map((await M.Employee.findAll({ where: { id: { [sequelize_1.Op.in]: [...new Set(ids.filter(Boolean))] } }, attributes: ['id', 'name', 'managerId'], raw: true })).map((x) => [x.id, x]));
const addMonths = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const CATS = ['safety', 'compliance', 'role', 'orientation', 'other'], MODES = ['online', 'in_person', 'self_study'];
// ---- courses
exports.trainingRouter.get('/courses', (0, http_1.wrap)(async (q, s) => s.json(await M.Course.findAll({ where: (0, services_1.isHR)(q.user) ? {} : { active: true }, order: [['title', 'ASC']] }))));
async function courseBody(b, partial = false, selfId) {
    const o = {};
    if (!partial || b.title !== undefined) {
        if (!txt(b.title, 200))
            throw (0, http_1.bad)('A course title is required');
        o.title = txt(b.title, 200);
    }
    if (!partial || b.category !== undefined) {
        if (!CATS.includes(b.category))
            throw (0, http_1.bad)('Choose a category');
        o.category = b.category;
    }
    if (!partial || b.deliveryMethod !== undefined) {
        if (!MODES.includes(b.deliveryMethod))
            throw (0, http_1.bad)('Choose a delivery method');
        o.deliveryMethod = b.deliveryMethod;
    }
    if (!partial || b.version !== undefined) {
        if (!txt(b.version, 20))
            throw (0, http_1.bad)('A course version is required');
        o.version = txt(b.version, 20);
    }
    if (b.description !== undefined)
        o.description = txt(b.description, 5000);
    if (b.passScore !== undefined) {
        if (b.passScore !== null && !(Number.isInteger(b.passScore) && b.passScore >= 1 && b.passScore <= 100))
            throw (0, http_1.bad)('Pass score must be 1-100');
        o.passScore = b.passScore;
    }
    if (b.recurrenceMonths !== undefined) {
        if (b.recurrenceMonths !== null && !(Number.isInteger(b.recurrenceMonths) && b.recurrenceMonths >= 1 && b.recurrenceMonths <= 60))
            throw (0, http_1.bad)('Recurrence must be 1-60 months');
        o.recurrenceMonths = b.recurrenceMonths;
    }
    if (b.prerequisiteId !== undefined && b.prerequisiteId !== null) {
        const pre = await M.Course.findByPk(id(b.prerequisiteId));
        if (!pre)
            throw (0, http_1.bad)('Prerequisite course not found', 404);
        if (selfId && pre.id === selfId)
            throw (0, http_1.bad)('A course cannot be its own prerequisite');
        o.prerequisiteId = pre.id;
    }
    else if (b.prerequisiteId === null)
        o.prerequisiteId = null;
    return o;
}
exports.trainingRouter.post('/courses', http_1.hr, (0, http_1.wrap)(async (q, s) => { const c = await M.Course.create({ ...(await courseBody(q.body)), createdBy: q.user.id }); await (0, services_1.log)(q.user.id, 'Course Created', `#${c.id} ${c.title} v${c.version}`); s.status(201).json(c); }));
exports.trainingRouter.patch('/courses/:id', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.Course.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    const o = await courseBody(q.body, true, c.id);
    if (q.body.active !== undefined)
        o.active = !!q.body.active;
    await c.update(o);
    await (0, services_1.log)(q.user.id, 'Course Updated', `#${c.id} v${c.version} (existing assignments keep the version they were assigned)`);
    s.json(c);
}));
// ---- assignments
const mayAssign = async (u, eid) => (0, services_1.isHR)(u) || (u.role === 'manager' && (await (0, services_1.teamOf)(u.id)).includes(eid));
const status = (a, today = (0, lifecycleCore_1.todayStr)()) => H.trainingStatus({ dueDate: a.dueDate, startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : null, completedAt: a.completedAt ? new Date(a.completedAt).toISOString() : null, today });
exports.trainingRouter.post('/training/assign', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const course = await M.Course.findByPk(id(q.body.courseId));
    if (!course || !course.active)
        throw (0, http_1.bad)('Course not found or retired', 404);
    const due = (0, lifecycleCore_1.isoDate)(q.body.dueDate);
    if (!due || due < (0, lifecycleCore_1.todayStr)())
        throw (0, http_1.bad)('Choose a due date that is not in the past');
    const ids = Array.isArray(q.body.employeeIds) ? q.body.employeeIds.map(Number) : [];
    if (!ids.length || ids.length > 100 || ids.some((n) => !Number.isInteger(n) || n <= 0))
        throw (0, http_1.bad)('Choose 1 to 100 employees');
    const out = { assigned: 0, skipped: [] };
    for (const eid of [...new Set(ids)]) {
        const e = await M.Employee.findByPk(eid);
        if (!e || e.status === 'terminated') {
            out.skipped.push(`#${eid}: not found`);
            continue;
        }
        if (eid === q.user.id) {
            out.skipped.push(`${e.name}: you cannot assign training to yourself`);
            continue;
        }
        if (!(await mayAssign(q.user, eid))) {
            out.skipped.push(`${e.name}: not on your team`);
            continue;
        }
        if (await M.CourseAssignment.findOne({ where: { courseId: course.id, employeeId: eid, completedAt: null } })) {
            out.skipped.push(`${e.name}: already assigned`);
            continue;
        }
        await M.CourseAssignment.create({ courseId: course.id, employeeId: eid, courseVersion: course.version, assignedBy: q.user.id, dueDate: due });
        out.assigned++;
        await ping(eid, 'New training assigned', `${course.title} (due ${due})`);
    }
    await (0, services_1.log)(q.user.id, 'Training Assigned', `course #${course.id} assigned:${out.assigned}`);
    s.status(201).json(out);
}));
exports.trainingRouter.get('/training', (0, http_1.wrap)(async (q, s) => {
    const rows = await M.CourseAssignment.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['dueDate', 'ASC']], limit: 500 });
    const cs = new Map((await M.Course.findAll({ raw: true })).map((c) => [c.id, c])), nm = await names(rows.map((r) => r.employeeId)), t = (0, lifecycleCore_1.todayStr)();
    s.json(rows.map((a) => ({ ...a.toJSON(), status: status(a, t), courseTitle: cs.get(a.courseId)?.title, passScore: cs.get(a.courseId)?.passScore, employeeName: nm.get(a.employeeId)?.name })));
}));
exports.trainingRouter.get('/training/compliance', http_1.hr, (0, http_1.wrap)(async (_q, s) => {
    const rows = await M.CourseAssignment.findAll({ raw: true }), cs = await M.Course.findAll({ raw: true }), t = (0, lifecycleCore_1.todayStr)();
    s.json(cs.map((c) => { const mine = rows.filter((r) => r.courseId === c.id).map((r) => status(r, t)); const n = (k) => mine.filter((x) => x === k).length; return { courseId: c.id, title: c.title, assigned: n('assigned'), inProgress: n('in_progress'), completed: n('completed'), overdue: n('overdue'), total: mine.length }; }));
}));
async function mine(q) { const a = await M.CourseAssignment.findOne({ where: { id: id(q.params.id), employeeId: q.user.id } }); if (!a)
    throw (0, http_1.bad)('Not found', 404); return a; }
async function prereqDone(a) { const c = await M.Course.findByPk(a.courseId); if (c?.prerequisiteId && !(await M.CourseAssignment.findOne({ where: { employeeId: a.employeeId, courseId: c.prerequisiteId, completedAt: { [sequelize_1.Op.ne]: null } } }))) {
    const p = await M.Course.findByPk(c.prerequisiteId);
    throw (0, http_1.bad)(`Complete the prerequisite first: ${p?.title}`, 409);
} return c; }
exports.trainingRouter.post('/training/:id/start', (0, http_1.wrap)(async (q, s) => { const a = await mine(q); if (a.completedAt)
    throw (0, http_1.bad)('Already completed', 409); await prereqDone(a); if (!a.startedAt)
    await a.update({ startedAt: new Date() }); s.json({ ok: true }); }));
async function finish(a, c, completedOn, by, extra) {
    const [n] = await M.CourseAssignment.update({ completedAt: completedOn, ...extra }, { where: { id: a.id, completedAt: null } });
    if (!n)
        throw (0, http_1.bad)('Already completed', 409);
    if (c?.recurrenceMonths) {
        const next = addMonths(completedOn.toISOString().slice(0, 10), c.recurrenceMonths);
        await M.CourseAssignment.create({ courseId: a.courseId, employeeId: a.employeeId, courseVersion: c.version, assignedBy: null, dueDate: next, recurredFromId: a.id });
    }
    const emp = await M.Employee.findByPk(a.employeeId);
    await ping(emp?.managerId, 'Training completed', `${emp?.name}: ${c?.title}`);
    await (0, services_1.log)(by, 'Training Completed', `assignment #${a.id} course #${a.courseId}`);
}
exports.trainingRouter.post('/training/:id/complete', (0, http_1.wrap)(async (q, s) => {
    const a = await mine(q);
    if (a.completedAt)
        throw (0, http_1.bad)('Already completed', 409);
    const c = await prereqDone(a);
    if (q.body.acknowledged !== true)
        throw (0, http_1.bad)('Acknowledge that you completed the training');
    let score = null;
    if (c.passScore) {
        score = Number(q.body.score);
        if (!Number.isFinite(score) || score < 0 || score > 100)
            throw (0, http_1.bad)('Enter your assessment score (0-100)');
        await a.update({ attempts: a.attempts + 1, startedAt: a.startedAt || new Date() }); // a.attempts is now the updated count
        if (score < c.passScore)
            return s.json({ passed: false, attempts: a.attempts, message: `Score ${score} is below the pass mark of ${c.passScore}. You can try again.` });
    }
    await finish(a, c, new Date(), q.user.id, { score, certificateRef: txt(q.body.certificateRef, 300) || null, attempts: a.attempts, startedAt: a.startedAt || new Date() });
    s.json({ passed: true });
}));
/** In-person / external training: HR records the completion with a reason. */
exports.trainingRouter.post('/training/:id/record', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const a = await M.CourseAssignment.findByPk(id(q.params.id));
    if (!a)
        throw (0, http_1.bad)('Not found', 404);
    if (a.completedAt)
        throw (0, http_1.bad)('Already completed', 409);
    if (a.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot record your own completion', 403);
    const on = (0, lifecycleCore_1.isoDate)(q.body.completedOn), note = txt(q.body.note, 500);
    if (!on || on > (0, lifecycleCore_1.todayStr)())
        throw (0, http_1.bad)('Enter the completion date (not in the future)');
    if (note.length < 5)
        throw (0, http_1.bad)('Say how the completion was verified (sign-in sheet, certificate...)');
    const c = await prereqDone(a), score = q.body.score == null ? null : Number(q.body.score);
    if (c.passScore && (score == null || score < c.passScore))
        throw (0, http_1.bad)(`This course has a pass mark of ${c.passScore}: enter a passing score`);
    await finish(a, c, new Date(on + 'T12:00:00Z'), q.user.id, { score, certificateRef: note, recordedBy: q.user.id, startedAt: a.startedAt || new Date() });
    s.json({ ok: true });
}));
// ---- manager competency review (probation / initial review)
exports.trainingRouter.post('/training/competency', http_1.staff, (0, http_1.wrap)(async (q, s) => {
    const eid = id(q.body.employeeId);
    if (eid === q.user.id)
        throw (0, http_1.bad)('You cannot review your own competency', 403);
    if (!(await mayAssign(q.user, eid)))
        throw (0, http_1.bad)('You can only review your own team', 403);
    const outcome = q.body.outcome, notes = txt(q.body.notes, 5000), fu = q.body.followUpDate ? (0, lifecycleCore_1.isoDate)(q.body.followUpDate) : null;
    if (!['approved', 'coaching', 'retraining'].includes(outcome))
        throw (0, http_1.bad)('Outcome: approved, coaching or retraining');
    if (notes.length < 10)
        throw (0, http_1.bad)('Record the observed evidence (at least 10 characters)');
    if (outcome !== 'approved' && !fu)
        throw (0, http_1.bad)('Coaching or retraining needs a follow-up date');
    if (fu && fu < (0, lifecycleCore_1.todayStr)())
        throw (0, http_1.bad)('The follow-up date cannot be in the past');
    const r = await M.CompetencyReview.create({ employeeId: eid, reviewerId: q.user.id, notes, outcome, followUpDate: fu });
    await ping(eid, 'Competency review recorded', `Outcome: ${outcome}`);
    await (0, services_1.log)(q.user.id, 'Competency Review', `employee #${eid} ${outcome}`);
    s.status(201).json(r);
}));
exports.trainingRouter.get('/training/competency', (0, http_1.wrap)(async (q, s) => { const rows = await M.CompetencyReview.findAll({ where: (0, services_1.inScope)(await (0, services_1.scopeIds)(q.user)), order: [['id', 'DESC']], limit: 200, raw: true }); const nm = await names(rows.map((r) => r.employeeId)); s.json(rows.map((r) => ({ ...r, employeeName: nm.get(r.employeeId)?.name }))); }));
async function runTrainingJob() {
    const t = (0, lifecycleCore_1.todayStr)();
    let reminded = 0, overdue = 0;
    const hrs = (await M.Employee.findAll({ where: { role: { [sequelize_1.Op.in]: ['hr', 'admin'] }, status: { [sequelize_1.Op.ne]: 'terminated' } }, attributes: ['id'], raw: true }));
    for (const a of (await M.CourseAssignment.findAll({ where: { completedAt: null } }))) {
        const e = await M.Employee.findByPk(a.employeeId), c = await M.Course.findByPk(a.courseId);
        if (!e || e.status === 'terminated')
            continue;
        if (a.dueDate < t && !a.overdueNotifiedAt) {
            await a.update({ overdueNotifiedAt: new Date() });
            for (const u of new Set([e.id, e.managerId, ...hrs.map((h) => h.id)].filter(Boolean)))
                await ping(u, 'Training overdue', `${e.name}: ${c?.title} was due ${a.dueDate}`);
            overdue++;
        }
        else if (a.dueDate >= t && a.dueDate <= (0, lifecycleCore_1.addDays)(t, 3) && !a.remindedAt) {
            await a.update({ remindedAt: new Date() });
            for (const u of new Set([e.id, e.managerId].filter(Boolean)))
                await ping(u, 'Training due soon', `${e.name}: ${c?.title} is due ${a.dueDate}`);
            reminded++;
        }
    }
    return { reminded, overdue };
}
