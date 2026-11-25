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
exports.complianceFlowRouter = void 0;
exports.generateComplianceTasks = generateComplianceTasks;
exports.runComplianceJob = runComplianceJob;
/** BPMN P3: tasks are created automatically from rules set per company and location, tracked to completion, escalated when overdue, and can be escalated, resolved or waived with a reason (audited). */
const express_1 = require("express");
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
const H = __importStar(require("./hrCore"));
const lifecycleCore_1 = require("./lifecycleCore");
exports.complianceFlowRouter = (0, express_1.Router)();
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const ping = (userId, title, body) => userId ? M.Notification.create({ userId, kind: 'compliance', title, body: body.slice(0, 1000), entityType: 'compliance', entityId: 0 }).catch(() => null) : null;
const hrAdminIds = async (roles = ['hr', 'admin']) => (await M.Employee.findAll({ where: { role: { [sequelize_1.Op.in]: roles }, status: { [sequelize_1.Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })).map((x) => x.id);
const jurs = (e) => { const st = String(e.workState || '').toUpperCase(), city = String(e.profile?.city || '').trim(); return [city && st ? `${st}:${city}` : '', st, 'US'].filter(Boolean); };
/** Rule keys beginning with task_ are compliance task rules, e.g. task_handbook {type, trigger: 'hire' | 'annual', dueDays, retentionYears}. */
async function generateComplianceTasks() {
    const rules = await M.ComplianceRule.findAll({ raw: true }), keys = [...new Set(rules.filter((r) => String(r.key).startsWith('task_')).map((r) => r.key))];
    const t = (0, lifecycleCore_1.todayStr)(), year = t.slice(0, 4);
    let created = 0;
    for (const e of (await M.Employee.findAll({ where: { status: { [sequelize_1.Op.in]: ['active', 'onboarding'] } } }))) {
        for (const key of keys) {
            const rule = H.ruleAt(rules, key, jurs(e), t);
            if (!rule)
                continue;
            const v = rule.value || {}, periodKey = v.trigger === 'annual' ? `${key}:${year}` : key;
            if (await M.ComplianceTask.findOne({ where: { employeeId: e.id, periodKey } }))
                continue;
            const base = v.trigger === 'annual' ? t : (e.startDate || t), due = (0, lifecycleCore_1.addDays)(base, Number(v.dueDays) || 7);
            await M.ComplianceTask.create({ employeeId: e.id, ownerId: e.id, type: String(v.type || key), dueDate: due, status: due < t ? 'overdue' : 'open', locationKey: String(e.workState || 'US').toUpperCase(), ruleId: rule.id, source: 'rule', periodKey });
            await ping(e.id, 'New compliance task', `${v.type || key}, due ${due}`);
            created++;
        }
    }
    return created;
}
async function runComplianceJob() {
    const t = (0, lifecycleCore_1.todayStr)(), created = await generateComplianceTasks();
    let overdue = 0, escalated = 0;
    await M.ComplianceTask.update({ status: 'overdue' }, { where: { status: 'open', dueDate: { [sequelize_1.Op.lt]: t } } });
    const hrs = await hrAdminIds(), admins = await hrAdminIds(['admin']);
    for (const k of (await M.ComplianceTask.findAll({ where: { status: 'overdue' } }))) {
        const e = k.employeeId ? await M.Employee.findByPk(k.employeeId) : null;
        if (!k.overdueNotifiedAt) {
            await k.update({ overdueNotifiedAt: new Date() });
            for (const u of new Set([k.ownerId || k.employeeId, e?.managerId, ...hrs].filter(Boolean)))
                await ping(u, 'Compliance task overdue', `${e?.name || ''}: ${k.type} was due ${k.dueDate}`);
            overdue++;
        }
        if (k.escalationLevel < 1 && k.dueDate < (0, lifecycleCore_1.addDays)(t, -7)) {
            await k.update({ escalationLevel: 1, escalatedAt: new Date() });
            for (const u of admins)
                await ping(u, 'Compliance task escalated', `${e?.name || ''}: ${k.type} is more than 7 days overdue`);
            escalated++;
        }
    }
    return { created, overdue, escalated };
}
exports.complianceFlowRouter.post('/compliance/generate', http_1.hr, (0, http_1.wrap)(async (q, s) => { const created = await generateComplianceTasks(); await (0, services_1.log)(q.user.id, 'Compliance Tasks Generated', `created:${created}`); s.json({ created }); }));
/** Dashboard: open, due soon and overdue, by task type and location. */
exports.complianceFlowRouter.get('/compliance/dashboard', http_1.hr, (0, http_1.wrap)(async (_q, s) => {
    const t = (0, lifecycleCore_1.todayStr)(), soon = (0, lifecycleCore_1.addDays)(t, 7), rows = await M.ComplianceTask.findAll({ raw: true }), emps = new Map((await M.Employee.findAll({ attributes: ['id', 'workState'], raw: true })).map((e) => [e.id, e.workState]));
    const g = new Map();
    for (const r of rows) {
        const loc = String(r.locationKey || emps.get(r.employeeId) || 'US').toUpperCase(), k = `${r.type}|${loc}`, x = g.get(k) || { type: r.type, location: loc, open: 0, dueSoon: 0, overdue: 0, done: 0, waived: 0 };
        if (r.status === 'done')
            x.done++;
        else if (r.status === 'waived')
            x.waived++;
        else if (r.status === 'overdue' || r.dueDate < t)
            x.overdue++;
        else {
            x.open++;
            if (r.dueDate <= soon)
                x.dueSoon++;
        }
        g.set(k, x);
    }
    s.json([...g.values()].sort((a, b) => b.overdue - a.overdue || a.type.localeCompare(b.type)));
}));
exports.complianceFlowRouter.post('/compliance/:id/escalate', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const k = await M.ComplianceTask.findByPk(Number(q.params.id));
    if (!k)
        throw (0, http_1.bad)('Not found', 404);
    if (!['open', 'overdue'].includes(k.status))
        throw (0, http_1.bad)('Only open or overdue tasks can be escalated', 409);
    const note = txt(q.body.note, 1000);
    if (note.length < 5)
        throw (0, http_1.bad)('A note is required');
    if (k.escalationLevel >= 3)
        throw (0, http_1.bad)('This task is already at the highest escalation level', 409);
    const e = k.employeeId ? await M.Employee.findByPk(k.employeeId) : null;
    await k.update({ escalationLevel: k.escalationLevel + 1, escalatedAt: new Date() });
    for (const u of new Set([...(await hrAdminIds(['admin'])), e?.managerId].filter(Boolean)))
        await ping(u, 'Compliance task escalated', `${e?.name || ''}: ${k.type} (${note})`);
    await (0, services_1.log)(q.user.id, 'Compliance Task Escalated', `#${k.id} level ${k.escalationLevel + 1}: ${note.slice(0, 150)}`);
    s.json(await M.ComplianceTask.findByPk(k.id));
}));
/** Waiving a requirement needs a reason and is audited; never for your own task. */
exports.complianceFlowRouter.post('/compliance/:id/waive', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const k = await M.ComplianceTask.findByPk(Number(q.params.id));
    if (!k)
        throw (0, http_1.bad)('Not found', 404);
    if (k.employeeId === q.user.id)
        throw (0, http_1.bad)('You cannot waive your own compliance task', 403);
    const reason = txt(q.body.reason, 1000);
    if (reason.length < 10)
        throw (0, http_1.bad)('A reason is required (at least 10 characters)');
    const [n] = await M.ComplianceTask.update({ status: 'waived', waivedBy: q.user.id, waiveReason: reason }, { where: { id: k.id, status: { [sequelize_1.Op.in]: ['open', 'overdue'] } } });
    if (!n)
        throw (0, http_1.bad)('Only open or overdue tasks can be waived', 409);
    await (0, services_1.log)(q.user.id, 'Compliance Task Waived', `#${k.id} ${k.type}: ${reason.slice(0, 200)}`);
    s.json(await M.ComplianceTask.findByPk(k.id));
}));
