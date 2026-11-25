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
exports.notifyHR = exports.uiInsuranceRouter = void 0;
exports.runUiJob = runUiJob;
exports.runInsuranceJob = runInsuranceJob;
/** P20/P21/S7 unemployment insurance claims and A8 insurance register. The STATE AGENCY decides eligibility: the HRMS only collects facts, deadlines and evidence. */
const express_1 = require("express");
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
const H = __importStar(require("./hrCore"));
const lifecycleCore_1 = require("./lifecycleCore");
exports.uiInsuranceRouter = (0, express_1.Router)();
const names = async (ids) => new Map((await M.Employee.findAll({ where: { id: { [sequelize_1.Op.in]: [...new Set(ids.filter(Boolean))] } }, attributes: ['id', 'name'], raw: true })).map((x) => [x.id, x.name]));
const hrAdmins = async () => (await M.Employee.findAll({ where: { role: { [sequelize_1.Op.in]: ['hr', 'admin'] }, status: { [sequelize_1.Op.ne]: 'terminated' } }, attributes: ['id'], raw: true }));
const notifyHR = async (title, body, link = '') => { for (const u of await hrAdmins())
    await M.Notification.create({ userId: u.id, kind: 'compliance', title, body: body.slice(0, 1000), entityType: 'claim', entityId: 0 }).catch(() => null); };
exports.notifyHR = notifyHR;
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0)
    throw (0, http_1.bad)('Invalid id'); return n; };
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
// ================= P20 / P21 / S7 unemployment =================
/** Separation record -> default UI reason code. HR must confirm: the termination letter's label does not decide a claim. */
const FROM_SEPARATION = { layoff: 'layoff', position_eliminated: 'layoff', end_of_contract: 'contract_ended', performance: 'performance', misconduct: 'misconduct', resignation: 'quit_no_cause', retirement: null, other: null };
const view = (c, nm) => ({ ...c.toJSON(), employeeName: nm?.get(c.employeeId), guidance: H.uiEvidence(c.uiReason), daysToResponse: c.responseDue && c.responseStatus === 'pending' ? Math.round((Date.parse(c.responseDue) - Date.parse((0, lifecycleCore_1.todayStr)())) / 864e5) : null });
exports.uiInsuranceRouter.get('/ui-claims', http_1.hr, (0, http_1.wrap)(async (_q, s) => { const rows = await M.UiClaim.findAll({ order: [['id', 'DESC']], limit: 300 }); const nm = await names(rows.map((r) => r.employeeId)); s.json(rows.map((r) => view(r, nm))); }));
exports.uiInsuranceRouter.get('/ui-claims/:id', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    const nm = await names([c.employeeId]);
    await (0, services_1.log)(q.user.id, 'UI Claim Viewed', `#${c.id}`);
    s.json({ ...view(c, nm), evidence: await M.UiEvidence.findAll({ where: { claimId: c.id }, order: [['id', 'ASC']] }), correspondence: await M.UiCorrespondence.findAll({ where: { claimId: c.id }, order: [['occurredOn', 'ASC'], ['id', 'ASC']] }), appeals: await M.UiAppeal.findAll({ where: { claimId: c.id } }) });
}));
exports.uiInsuranceRouter.post('/ui-claims', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const eid = id(q.body.employeeId), e = await M.Employee.findByPk(eid);
    if (!e)
        throw (0, http_1.bad)('Employee not found', 404);
    const off = await M.Offboarding.findOne({ where: { employeeId: eid, status: { [sequelize_1.Op.in]: ['in_progress', 'complete'] } }, order: [['id', 'DESC']] });
    if (!off)
        throw (0, http_1.bad)('Record the separation (offboarding) first: the claim needs the true reason and last day', 400);
    if (!H.UI_REASONS.includes(q.body.uiReason))
        throw (0, http_1.bad)('Choose the true separation reason');
    const suggested = FROM_SEPARATION[off.reason] ?? null, note = txt(q.body.reasonNote, 1000);
    if (suggested && q.body.uiReason !== suggested && note.length < 10)
        throw (0, http_1.bad)(`The offboarding record says "${off.reason}" but you chose "${q.body.uiReason}": explain the difference (at least 10 characters). Record the true reason and keep it consistent`);
    if (await M.UiClaim.findOne({ where: { employeeId: eid, status: { [sequelize_1.Op.ne]: 'closed' } } }))
        throw (0, http_1.bad)('An open claim already exists for this employee', 409);
    const filed = q.body.claimFiledDate ? (0, lifecycleCore_1.isoDate)(q.body.claimFiledDate) : null;
    if (q.body.claimFiledDate && !filed)
        throw (0, http_1.bad)('Enter a valid filing date');
    const state = txt(q.body.state || e.workState, 2).toUpperCase();
    if (!/^[A-Z]{2}$/.test(state))
        throw (0, http_1.bad)('Enter the work state (2 letters): claims are filed in the state where the work was done');
    const c = await M.UiClaim.create({ employeeId: eid, offboardingId: off.id, state, uiReason: q.body.uiReason, reasonNote: note || null, lastDay: off.terminationDate, claimFiledDate: filed, createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'UI Claim Opened', `#${c.id} employee #${eid} ${state}${suggested && q.body.uiReason !== suggested ? ' (reason differs from separation record)' : ''}`);
    s.status(201).json(view(c, new Map([[eid, e.name]])));
}));
exports.uiInsuranceRouter.post('/ui-claims/:id/notice', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    if (c.status === 'closed')
        throw (0, http_1.bad)('This claim is closed', 409);
    if (c.agencyNoticeDate)
        throw (0, http_1.bad)('The agency notice is already recorded: add the new document under correspondence', 409);
    const nd = (0, lifecycleCore_1.isoDate)(q.body.noticeDate), days = q.body.responseDays === undefined ? 10 : Number(q.body.responseDays);
    if (!nd)
        throw (0, http_1.bad)('Enter the date on the agency notice');
    if (!Number.isInteger(days) || days < 1 || days > 60)
        throw (0, http_1.bad)('Response days must be 1-60 (agencies often allow 7 to 10: use the number printed on the notice)');
    const due = H.uiResponseDue(nd, days);
    await c.update({ agencyNoticeDate: nd, responseDays: days, responseDue: due, responseStatus: 'pending', status: 'response_due', agencyClaimId: txt(q.body.agencyClaimId, 60) || c.agencyClaimId });
    await M.UiCorrespondence.create({ claimId: c.id, direction: 'from_agency', occurredOn: nd, summary: 'Request for separation and wage details', createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'UI Notice Recorded', `#${c.id} response due ${due}`);
    await (0, exports.notifyHR)('UI response deadline', `Claim #${c.id}: employer response due ${due}`);
    s.json(view(await M.UiClaim.findByPk(c.id)));
}));
exports.uiInsuranceRouter.post('/ui-claims/:id/evidence', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    if (c.status === 'closed')
        throw (0, http_1.bad)('This claim is closed', 409);
    const KINDS = ['policy', 'warning', 'attendance', 'incident', 'performance', 'payroll', 'complaint', 'notice', 'other'];
    if (!KINDS.includes(q.body.kind))
        throw (0, http_1.bad)('Choose an evidence type');
    if (!txt(q.body.title, 200))
        throw (0, http_1.bad)('A title is required');
    const dd = q.body.docDate ? (0, lifecycleCore_1.isoDate)(q.body.docDate) : null;
    if (q.body.docDate && !dd)
        throw (0, http_1.bad)('Enter a valid document date');
    const ev = await M.UiEvidence.create({ claimId: c.id, kind: q.body.kind, title: txt(q.body.title, 200), description: txt(q.body.description, 5000), source: txt(q.body.source, 200), docDate: dd, addedBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'UI Evidence Added', `claim #${c.id} ${q.body.kind}`);
    s.status(201).json(ev);
}));
exports.uiInsuranceRouter.post('/ui-claims/:id/correspondence', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    const d = (0, lifecycleCore_1.isoDate)(q.body.date);
    if (!['from_agency', 'to_agency'].includes(q.body.direction))
        throw (0, http_1.bad)('Choose the direction');
    if (!d)
        throw (0, http_1.bad)('Enter a valid date');
    if (txt(q.body.summary, 5000).length < 5)
        throw (0, http_1.bad)('Summarise the document');
    const r = await M.UiCorrespondence.create({ claimId: c.id, direction: q.body.direction, occurredOn: d, summary: txt(q.body.summary, 5000), createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'UI Correspondence Added', `claim #${c.id} ${q.body.direction}`);
    s.status(201).json(r);
}));
/** Employer response: accurate and supported by records. False answers can bring penalties (A6), so a confirmation and evidence are required. */
exports.uiInsuranceRouter.post('/ui-claims/:id/respond', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    const text = txt(q.body.responseText, 8000);
    if (c.responseStatus !== 'pending')
        throw (0, http_1.bad)(c.responseStatus === 'not_requested' ? 'Record the agency notice first' : 'A response was already recorded', 409);
    if (text.length < 20)
        throw (0, http_1.bad)('Write the employer response (at least 20 characters): reason, dates and wages');
    if (q.body.accuracyConfirmed !== true)
        throw (0, http_1.bad)('Confirm that the response is accurate and supported by records');
    if (!(await M.UiEvidence.count({ where: { claimId: c.id } })))
        throw (0, http_1.bad)('Attach at least one piece of evidence (policy, warnings, attendance, payroll records...) before responding');
    const late = (0, lifecycleCore_1.todayStr)() > c.responseDue;
    const [n] = await M.UiClaim.update({ responseStatus: late ? 'submitted_late' : 'submitted', responseText: text, respondedAt: new Date(), status: 'responded' }, { where: { id: c.id, responseStatus: 'pending' } });
    if (!n)
        throw (0, http_1.bad)('A response was already recorded', 409);
    await M.UiCorrespondence.create({ claimId: c.id, direction: 'to_agency', occurredOn: (0, lifecycleCore_1.todayStr)(), summary: 'Employer response submitted: ' + text.slice(0, 300), createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, late ? 'UI Response Submitted LATE' : 'UI Response Submitted', `#${c.id}`);
    s.json(view(await M.UiClaim.findByPk(c.id)));
}));
/** HR records what the AGENCY decided (from its determination letter). It is never calculated here from the reason code. */
exports.uiInsuranceRouter.post('/ui-claims/:id/determination', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    if (c.agencyDecision !== 'pending')
        throw (0, http_1.bad)('The agency determination is already recorded', 409);
    if (c.status === 'closed')
        throw (0, http_1.bad)('This claim is closed', 409);
    const decision = q.body.decision, dd = (0, lifecycleCore_1.isoDate)(q.body.decisionDate), appealDays = q.body.appealDays === undefined ? 10 : Number(q.body.appealDays);
    if (!['eligible', 'denied'].includes(decision))
        throw (0, http_1.bad)('Record the agency decision: eligible or denied');
    if (!dd)
        throw (0, http_1.bad)('Enter the date on the agency determination');
    if (!Number.isInteger(appealDays) || appealDays < 1 || appealDays > 60)
        throw (0, http_1.bad)('Appeal days must be 1-60 (use the deadline printed on the determination; agencies often allow 10 to 30)');
    const [n] = await M.UiClaim.update({ agencyDecision: decision, decisionDate: dd, decisionNotes: txt(q.body.notes, 1000) || null, weeklyBenefit: q.body.weeklyBenefit ?? null, benefitWeeks: q.body.benefitWeeks ?? null, appealDays, appealDeadline: (0, lifecycleCore_1.addDays)(dd, appealDays), status: 'determined' }, { where: { id: c.id, agencyDecision: 'pending' } });
    if (!n)
        throw (0, http_1.bad)('The agency determination is already recorded', 409);
    await M.UiCorrespondence.create({ claimId: c.id, direction: 'from_agency', occurredOn: dd, summary: `Agency determination: ${decision}`, createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'UI Agency Determination Recorded', `#${c.id} ${decision} appeal deadline ${(0, lifecycleCore_1.addDays)(dd, appealDays)}`);
    await (0, exports.notifyHR)('UI determination recorded', `Claim #${c.id}: ${decision}. Appeal deadline ${(0, lifecycleCore_1.addDays)(dd, appealDays)}`);
    s.json(view(await M.UiClaim.findByPk(c.id)));
}));
exports.uiInsuranceRouter.post('/ui-claims/:id/appeal', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    if (c.agencyDecision === 'pending')
        throw (0, http_1.bad)('There is no determination to appeal yet', 409);
    const side = q.body.side, fd = (0, lifecycleCore_1.isoDate)(q.body.filedDate);
    if (!['employer', 'employee'].includes(side))
        throw (0, http_1.bad)('Choose employer or employee');
    if (!fd)
        throw (0, http_1.bad)('Enter the filing date');
    if (side === 'employer' && fd > c.appealDeadline)
        throw (0, http_1.bad)(`The appeal deadline (${c.appealDeadline}) has passed`, 409);
    if (await M.UiAppeal.findOne({ where: { claimId: c.id, side } }))
        throw (0, http_1.bad)(`An ${side} appeal is already recorded`, 409);
    const a = await M.UiAppeal.create({ claimId: c.id, side, filedDate: fd, notes: txt(q.body.notes, 2000), createdBy: q.user.id });
    await c.update({ status: 'appealed' });
    await (0, services_1.log)(q.user.id, 'UI Appeal Recorded', `#${c.id} ${side}`);
    s.status(201).json(a);
}));
exports.uiInsuranceRouter.post('/ui-claims/:id/close', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const c = await M.UiClaim.findByPk(id(q.params.id));
    if (!c)
        throw (0, http_1.bad)('Not found', 404);
    if (c.status === 'closed')
        throw (0, http_1.bad)('Already closed', 409);
    const note = txt(q.body.note, 1000);
    if (c.agencyDecision === 'pending' && note.length < 10)
        throw (0, http_1.bad)('No determination is recorded: explain why the claim is being closed (at least 10 characters)');
    await c.update({ status: 'closed', closedAt: new Date(), closeNote: note || null });
    await (0, services_1.log)(q.user.id, 'UI Claim Closed', `#${c.id}`);
    s.json(view(c));
}));
async function runUiJob() {
    const t = (0, lifecycleCore_1.todayStr)();
    let reminded = 0, missed = 0;
    for (const c of (await M.UiClaim.findAll({ where: { responseStatus: 'pending' } }))) {
        if (c.responseDue < t) {
            await c.update({ responseStatus: 'missed', lateEscalatedAt: new Date() });
            await (0, exports.notifyHR)('UI response deadline MISSED', `Claim #${c.id}: the employer response was due ${c.responseDue}. Late replies can lose the right to contest: respond now and tell the agency`);
            missed++;
        }
        else if (!c.remindedAt && c.responseDue <= (0, lifecycleCore_1.addDays)(t, 2)) {
            await c.update({ remindedAt: new Date() });
            await (0, exports.notifyHR)('UI response due soon', `Claim #${c.id}: response due ${c.responseDue}`);
            reminded++;
        }
    }
    return { reminded, missed };
}
// ================= A8 insurance register =================
const money = (v, what) => { const n = Number(v); if (!(n >= 0))
    throw (0, http_1.bad)(`${what} must be 0 or more`); return Math.round(n * 100) / 100; };
function policyBody(b, partial = false) {
    const out = {};
    if (!partial || b.type !== undefined) {
        if (!H.INSURANCE.includes(b.type))
            throw (0, http_1.bad)('Choose one of the 15 policy types');
        out.type = b.type;
    }
    if (!partial || b.insurer !== undefined) {
        if (!txt(b.insurer, 160))
            throw (0, http_1.bad)('Insurer is required');
        out.insurer = txt(b.insurer, 160);
    }
    if (!partial || b.policyNumber !== undefined) {
        if (!txt(b.policyNumber, 80))
            throw (0, http_1.bad)('Policy number is required');
        out.policyNumber = txt(b.policyNumber, 80);
    }
    if (!partial || b.coverageLimit !== undefined)
        out.coverageLimit = money(b.coverageLimit, 'Coverage limit');
    if (!partial || b.premium !== undefined)
        out.premium = money(b.premium, 'Premium');
    if (!partial || b.premiumFrequency !== undefined) {
        if (!['monthly', 'quarterly', 'annual'].includes(b.premiumFrequency))
            throw (0, http_1.bad)('Premium frequency: monthly, quarterly or annual');
        out.premiumFrequency = b.premiumFrequency;
    }
    if (!partial || b.effectiveDate !== undefined) {
        const d = (0, lifecycleCore_1.isoDate)(b.effectiveDate);
        if (!d)
            throw (0, http_1.bad)('Enter a valid effective date');
        out.effectiveDate = d;
    }
    if (!partial || b.expirationDate !== undefined) {
        const d = (0, lifecycleCore_1.isoDate)(b.expirationDate);
        if (!d)
            throw (0, http_1.bad)('Enter a valid expiration date');
        out.expirationDate = d;
    }
    if (b.exclusions !== undefined)
        out.exclusions = txt(b.exclusions, 5000);
    if (b.notes !== undefined)
        out.notes = txt(b.notes, 5000);
    if (b.claimsContact !== undefined) {
        const c = b.claimsContact || {};
        out.claimsContact = { name: txt(c.name, 120), phone: txt(c.phone, 40), email: txt(c.email, 160) };
    }
    return out;
}
exports.uiInsuranceRouter.get('/insurance/types', http_1.hr, (0, http_1.wrap)(async (_q, s) => {
    const ps = await M.InsurancePolicy.findAll({ where: { status: 'active' }, raw: true });
    s.json(H.INSURANCE.map((t, i) => ({ no: i + 1, type: t, activePolicies: ps.filter((p) => p.type === t).length, note: t === 'Unemployment Insurance' ? 'A state payroll-tax program: record the state account and rate here' : t === 'Employment-Related Practices Liability' ? 'May overlap with EPLI (#3): confirm with your broker' : undefined })));
}));
exports.uiInsuranceRouter.get('/insurance/renewals', http_1.hr, (0, http_1.wrap)(async (_q, s) => {
    const t = (0, lifecycleCore_1.todayStr)(), ps = await M.InsurancePolicy.findAll({ where: { status: { [sequelize_1.Op.in]: ['active', 'expired'] } }, order: [['expirationDate', 'ASC']], raw: true });
    s.json(ps.map((p) => ({ id: p.id, type: p.type, insurer: p.insurer, policyNumber: p.policyNumber, expirationDate: p.expirationDate, status: p.status, bucket: H.renewalBucket(p.expirationDate, t), daysLeft: Math.round((Date.parse(p.expirationDate) - Date.parse(t)) / 864e5) })));
}));
exports.uiInsuranceRouter.get('/insurance', http_1.hr, (0, http_1.wrap)(async (_q, s) => { const t = (0, lifecycleCore_1.todayStr)(); s.json((await M.InsurancePolicy.findAll({ order: [['type', 'ASC'], ['expirationDate', 'ASC']] })).map((p) => ({ ...p.toJSON(), bucket: H.renewalBucket(p.expirationDate, t) }))); }));
exports.uiInsuranceRouter.get('/insurance/:id', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const p = await M.InsurancePolicy.findByPk(id(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    const items = await M.InsuredItem.findAll({ where: { policyId: p.id } }), nm = await names(items.map((i) => i.employeeId));
    s.json({ ...p.toJSON(), bucket: H.renewalBucket(p.expirationDate, (0, lifecycleCore_1.todayStr)()), insured: items.map((i) => ({ ...i.toJSON(), employeeName: nm.get(i.employeeId) })), documents: await M.InsuranceDocument.findAll({ where: { policyId: p.id } }) });
}));
exports.uiInsuranceRouter.post('/insurance', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const v = policyBody(q.body);
    if (v.expirationDate <= v.effectiveDate)
        throw (0, http_1.bad)('The expiration date must be after the effective date');
    if (await M.InsurancePolicy.findOne({ where: { type: v.type, policyNumber: v.policyNumber } }))
        throw (0, http_1.bad)('This policy number is already recorded for that type', 409);
    const p = await M.InsurancePolicy.create({ ...v, createdBy: q.user.id, status: 'active', remindersSent: [] });
    await (0, services_1.log)(q.user.id, 'Insurance Policy Added', `#${p.id} ${v.type}`);
    s.status(201).json(p);
}));
exports.uiInsuranceRouter.patch('/insurance/:id', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const p = await M.InsurancePolicy.findByPk(id(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    const v = policyBody(q.body, true), exp = v.expirationDate ?? p.expirationDate, eff = v.effectiveDate ?? p.effectiveDate;
    if (exp <= eff)
        throw (0, http_1.bad)('The expiration date must be after the effective date');
    const up = { ...v };
    if (q.body.status !== undefined) {
        if (!['active', 'cancelled'].includes(q.body.status))
            throw (0, http_1.bad)('Status: active or cancelled');
        up.status = q.body.status;
    }
    if (v.expirationDate && v.expirationDate !== p.expirationDate) {
        up.remindersSent = [];
        if (p.status === 'expired')
            up.status = 'active';
    } // a renewal restarts the reminders
    const before = { limit: p.coverageLimit, premium: p.premium, exp: p.expirationDate };
    await p.update(up);
    await (0, services_1.log)(q.user.id, 'Insurance Policy Updated', `#${p.id} ${JSON.stringify(before)} -> ${JSON.stringify({ limit: p.coverageLimit, premium: p.premium, exp: p.expirationDate })}`);
    s.json(p);
}));
exports.uiInsuranceRouter.post('/insurance/:id/insured', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const p = await M.InsurancePolicy.findByPk(id(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    if (!['person', 'asset'].includes(q.body.kind))
        throw (0, http_1.bad)('Choose person or asset');
    if (q.body.kind === 'person') {
        const e = await M.Employee.findByPk(id(q.body.employeeId));
        if (!e)
            throw (0, http_1.bad)('Employee not found', 404);
        const it = await M.InsuredItem.create({ policyId: p.id, kind: 'person', employeeId: e.id, label: e.name, details: txt(q.body.details, 2000) });
        await (0, services_1.log)(q.user.id, 'Insured Added', `policy #${p.id} employee #${e.id}`);
        return s.status(201).json(it);
    }
    if (!txt(q.body.label, 200))
        throw (0, http_1.bad)('Describe the covered asset (vehicle, building, equipment...)');
    const it = await M.InsuredItem.create({ policyId: p.id, kind: 'asset', label: txt(q.body.label, 200), details: txt(q.body.details, 2000) });
    await (0, services_1.log)(q.user.id, 'Insured Added', `policy #${p.id} asset`);
    s.status(201).json(it);
}));
exports.uiInsuranceRouter.delete('/insurance/:id/insured/:iid', http_1.hr, (0, http_1.wrap)(async (q, s) => { const n = await M.InsuredItem.destroy({ where: { id: id(q.params.iid), policyId: id(q.params.id) } }); if (!n)
    throw (0, http_1.bad)('Not found', 404); await (0, services_1.log)(q.user.id, 'Insured Removed', `policy #${q.params.id}`); s.json({ ok: true }); }));
exports.uiInsuranceRouter.post('/insurance/:id/documents', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const p = await M.InsurancePolicy.findByPk(id(q.params.id));
    if (!p)
        throw (0, http_1.bad)('Not found', 404);
    if (!['certificate', 'policy', 'endorsement', 'claim_form', 'other'].includes(q.body.kind))
        throw (0, http_1.bad)('Choose a document type');
    if (!txt(q.body.title, 200))
        throw (0, http_1.bad)('A title is required');
    const d = await M.InsuranceDocument.create({ policyId: p.id, kind: q.body.kind, title: txt(q.body.title, 200), reference: txt(q.body.reference, 500), issuedDate: q.body.issuedDate ? (0, lifecycleCore_1.isoDate)(q.body.issuedDate) : null, addedBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'Insurance Document Added', `policy #${p.id} ${q.body.kind}`);
    s.status(201).json(d);
}));
/** Renewal reminders at 90/60/30/7 days (once per threshold) and automatic expiry with a compliance task. */
async function runInsuranceJob() {
    const t = (0, lifecycleCore_1.todayStr)();
    let reminders = 0, expired = 0;
    const ORDER = ['d90', 'd60', 'd30', 'd7'];
    for (const p of (await M.InsurancePolicy.findAll({ where: { status: 'active' } }))) {
        const b = H.renewalBucket(p.expirationDate, t), sent = p.remindersSent || [];
        if (b === 'expired') {
            await p.update({ status: 'expired' });
            await M.ComplianceTask.create({ employeeId: p.createdBy, type: `Insurance expired: ${p.type} (${p.policyNumber})`, dueDate: p.expirationDate, status: 'overdue' });
            await (0, exports.notifyHR)('Insurance policy expired', `${p.type} (${p.policyNumber}) expired on ${p.expirationDate}`);
            expired++;
        }
        else if (b !== 'ok' && !sent.includes(b)) {
            await p.update({ remindersSent: [...sent, ...ORDER.slice(0, ORDER.indexOf(b) + 1)].filter((x, i, a) => a.indexOf(x) === i) });
            await (0, exports.notifyHR)('Insurance renewal coming up', `${p.type} (${p.policyNumber}) expires ${p.expirationDate}`);
            reminders++;
        }
    }
    return { reminders, expired };
}
