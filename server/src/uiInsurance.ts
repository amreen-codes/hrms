/** P20/P21/S7 unemployment insurance claims and A8 insurance register. The STATE AGENCY decides eligibility: the HRMS only collects facts, deadlines and evidence. */
import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import { log } from './services';
import { wrap, bad, hr } from './http';
import * as H from './hrCore';
import { isoDate, todayStr, addDays } from './lifecycleCore';

export const uiInsuranceRouter = Router();
const names = async (ids: number[]) => new Map(((await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids.filter(Boolean))] } }, attributes: ['id', 'name'], raw: true })) as any[]).map((x) => [x.id, x.name]));
const hrAdmins = async () => (await M.Employee.findAll({ where: { role: { [Op.in]: ['hr', 'admin'] }, status: { [Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })) as any[];
export const notifyHR = async (title: string, body: string, link = '') => { for (const u of await hrAdmins()) await M.Notification.create({ userId: u.id, kind: 'compliance', title, body: body.slice(0, 1000), entityType: 'claim', entityId: 0 } as any).catch(() => null); };
const id = (v: any) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id'); return n; };
const txt = (v: any, max: number) => String(v ?? '').trim().slice(0, max);

// ================= P20 / P21 / S7 unemployment =================
/** Separation record -> default UI reason code. HR must confirm: the termination letter's label does not decide a claim. */
const FROM_SEPARATION: Record<string, string | null> = { layoff: 'layoff', position_eliminated: 'layoff', end_of_contract: 'contract_ended', performance: 'performance', misconduct: 'misconduct', resignation: 'quit_no_cause', retirement: null, other: null };
const view = (c: any, nm?: Map<number, string>) => ({ ...c.toJSON(), employeeName: nm?.get(c.employeeId), guidance: H.uiEvidence(c.uiReason), daysToResponse: c.responseDue && c.responseStatus === 'pending' ? Math.round((Date.parse(c.responseDue) - Date.parse(todayStr())) / 864e5) : null });
uiInsuranceRouter.get('/ui-claims', hr, wrap(async (_q, s) => { const rows: any[] = await M.UiClaim.findAll({ order: [['id', 'DESC']], limit: 300 }); const nm = await names(rows.map((r) => r.employeeId)); s.json(rows.map((r) => view(r, nm))); }));
uiInsuranceRouter.get('/ui-claims/:id', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); const nm = await names([c.employeeId]);
  await log(q.user.id, 'UI Claim Viewed', `#${c.id}`);
  s.json({ ...view(c, nm), evidence: await M.UiEvidence.findAll({ where: { claimId: c.id }, order: [['id', 'ASC']] }), correspondence: await M.UiCorrespondence.findAll({ where: { claimId: c.id }, order: [['occurredOn', 'ASC'], ['id', 'ASC']] }), appeals: await M.UiAppeal.findAll({ where: { claimId: c.id } }) });
}));
uiInsuranceRouter.post('/ui-claims', hr, wrap(async (q, s) => {
  const eid = id(q.body.employeeId), e: any = await M.Employee.findByPk(eid); if (!e) throw bad('Employee not found', 404);
  const off: any = await M.Offboarding.findOne({ where: { employeeId: eid, status: { [Op.in]: ['in_progress', 'complete'] } }, order: [['id', 'DESC']] });
  if (!off) throw bad('Record the separation (offboarding) first: the claim needs the true reason and last day', 400);
  if (!H.UI_REASONS.includes(q.body.uiReason)) throw bad('Choose the true separation reason');
  const suggested = FROM_SEPARATION[off.reason] ?? null, note = txt(q.body.reasonNote, 1000);
  if (suggested && q.body.uiReason !== suggested && note.length < 10) throw bad(`The offboarding record says "${off.reason}" but you chose "${q.body.uiReason}": explain the difference (at least 10 characters). Record the true reason and keep it consistent`);
  if (await M.UiClaim.findOne({ where: { employeeId: eid, status: { [Op.ne]: 'closed' } } })) throw bad('An open claim already exists for this employee', 409);
  const filed = q.body.claimFiledDate ? isoDate(q.body.claimFiledDate) : null; if (q.body.claimFiledDate && !filed) throw bad('Enter a valid filing date');
  const state = txt(q.body.state || e.workState, 2).toUpperCase(); if (!/^[A-Z]{2}$/.test(state)) throw bad('Enter the work state (2 letters): claims are filed in the state where the work was done');
  const c: any = await M.UiClaim.create({ employeeId: eid, offboardingId: off.id, state, uiReason: q.body.uiReason, reasonNote: note || null, lastDay: off.terminationDate, claimFiledDate: filed, createdBy: q.user.id } as any);
  await log(q.user.id, 'UI Claim Opened', `#${c.id} employee #${eid} ${state}${suggested && q.body.uiReason !== suggested ? ' (reason differs from separation record)' : ''}`); s.status(201).json(view(c, new Map([[eid, e.name]])));
}));
uiInsuranceRouter.post('/ui-claims/:id/notice', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); if (c.status === 'closed') throw bad('This claim is closed', 409);
  if (c.agencyNoticeDate) throw bad('The agency notice is already recorded: add the new document under correspondence', 409);
  const nd = isoDate(q.body.noticeDate), days = q.body.responseDays === undefined ? 10 : Number(q.body.responseDays);
  if (!nd) throw bad('Enter the date on the agency notice'); if (!Number.isInteger(days) || days < 1 || days > 60) throw bad('Response days must be 1-60 (agencies often allow 7 to 10: use the number printed on the notice)');
  const due = H.uiResponseDue(nd, days);
  await c.update({ agencyNoticeDate: nd, responseDays: days, responseDue: due, responseStatus: 'pending', status: 'response_due', agencyClaimId: txt(q.body.agencyClaimId, 60) || c.agencyClaimId });
  await M.UiCorrespondence.create({ claimId: c.id, direction: 'from_agency', occurredOn: nd, summary: 'Request for separation and wage details', createdBy: q.user.id } as any);
  await log(q.user.id, 'UI Notice Recorded', `#${c.id} response due ${due}`); await notifyHR('UI response deadline', `Claim #${c.id}: employer response due ${due}`); s.json(view(await M.UiClaim.findByPk(c.id) as any));
}));
uiInsuranceRouter.post('/ui-claims/:id/evidence', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); if (c.status === 'closed') throw bad('This claim is closed', 409);
  const KINDS = ['policy', 'warning', 'attendance', 'incident', 'performance', 'payroll', 'complaint', 'notice', 'other']; if (!KINDS.includes(q.body.kind)) throw bad('Choose an evidence type');
  if (!txt(q.body.title, 200)) throw bad('A title is required'); const dd = q.body.docDate ? isoDate(q.body.docDate) : null; if (q.body.docDate && !dd) throw bad('Enter a valid document date');
  const ev: any = await M.UiEvidence.create({ claimId: c.id, kind: q.body.kind, title: txt(q.body.title, 200), description: txt(q.body.description, 5000), source: txt(q.body.source, 200), docDate: dd, addedBy: q.user.id } as any);
  await log(q.user.id, 'UI Evidence Added', `claim #${c.id} ${q.body.kind}`); s.status(201).json(ev);
}));
uiInsuranceRouter.post('/ui-claims/:id/correspondence', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); const d = isoDate(q.body.date);
  if (!['from_agency', 'to_agency'].includes(q.body.direction)) throw bad('Choose the direction'); if (!d) throw bad('Enter a valid date'); if (txt(q.body.summary, 5000).length < 5) throw bad('Summarise the document');
  const r: any = await M.UiCorrespondence.create({ claimId: c.id, direction: q.body.direction, occurredOn: d, summary: txt(q.body.summary, 5000), createdBy: q.user.id } as any); await log(q.user.id, 'UI Correspondence Added', `claim #${c.id} ${q.body.direction}`); s.status(201).json(r);
}));
/** Employer response: accurate and supported by records. False answers can bring penalties (A6), so a confirmation and evidence are required. */
uiInsuranceRouter.post('/ui-claims/:id/respond', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); const text = txt(q.body.responseText, 8000);
  if (c.responseStatus !== 'pending') throw bad(c.responseStatus === 'not_requested' ? 'Record the agency notice first' : 'A response was already recorded', 409);
  if (text.length < 20) throw bad('Write the employer response (at least 20 characters): reason, dates and wages'); if (q.body.accuracyConfirmed !== true) throw bad('Confirm that the response is accurate and supported by records');
  if (!(await M.UiEvidence.count({ where: { claimId: c.id } }))) throw bad('Attach at least one piece of evidence (policy, warnings, attendance, payroll records...) before responding');
  const late = todayStr() > c.responseDue;
  const [n] = await M.UiClaim.update({ responseStatus: late ? 'submitted_late' : 'submitted', responseText: text, respondedAt: new Date(), status: 'responded' } as any, { where: { id: c.id, responseStatus: 'pending' } }); if (!n) throw bad('A response was already recorded', 409);
  await M.UiCorrespondence.create({ claimId: c.id, direction: 'to_agency', occurredOn: todayStr(), summary: 'Employer response submitted: ' + text.slice(0, 300), createdBy: q.user.id } as any);
  await log(q.user.id, late ? 'UI Response Submitted LATE' : 'UI Response Submitted', `#${c.id}`); s.json(view(await M.UiClaim.findByPk(c.id) as any));
}));
/** HR records what the AGENCY decided (from its determination letter). It is never calculated here from the reason code. */
uiInsuranceRouter.post('/ui-claims/:id/determination', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); if (c.agencyDecision !== 'pending') throw bad('The agency determination is already recorded', 409); if (c.status === 'closed') throw bad('This claim is closed', 409);
  const decision = q.body.decision, dd = isoDate(q.body.decisionDate), appealDays = q.body.appealDays === undefined ? 10 : Number(q.body.appealDays);
  if (!['eligible', 'denied'].includes(decision)) throw bad('Record the agency decision: eligible or denied'); if (!dd) throw bad('Enter the date on the agency determination');
  if (!Number.isInteger(appealDays) || appealDays < 1 || appealDays > 60) throw bad('Appeal days must be 1-60 (use the deadline printed on the determination; agencies often allow 10 to 30)');
  const [n] = await M.UiClaim.update({ agencyDecision: decision, decisionDate: dd, decisionNotes: txt(q.body.notes, 1000) || null, weeklyBenefit: q.body.weeklyBenefit ?? null, benefitWeeks: q.body.benefitWeeks ?? null, appealDays, appealDeadline: addDays(dd, appealDays), status: 'determined' } as any, { where: { id: c.id, agencyDecision: 'pending' } });
  if (!n) throw bad('The agency determination is already recorded', 409);
  await M.UiCorrespondence.create({ claimId: c.id, direction: 'from_agency', occurredOn: dd, summary: `Agency determination: ${decision}`, createdBy: q.user.id } as any);
  await log(q.user.id, 'UI Agency Determination Recorded', `#${c.id} ${decision} appeal deadline ${addDays(dd, appealDays)}`); await notifyHR('UI determination recorded', `Claim #${c.id}: ${decision}. Appeal deadline ${addDays(dd, appealDays)}`); s.json(view(await M.UiClaim.findByPk(c.id) as any));
}));
uiInsuranceRouter.post('/ui-claims/:id/appeal', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); if (c.agencyDecision === 'pending') throw bad('There is no determination to appeal yet', 409);
  const side = q.body.side, fd = isoDate(q.body.filedDate); if (!['employer', 'employee'].includes(side)) throw bad('Choose employer or employee'); if (!fd) throw bad('Enter the filing date');
  if (side === 'employer' && fd > c.appealDeadline) throw bad(`The appeal deadline (${c.appealDeadline}) has passed`, 409);
  if (await M.UiAppeal.findOne({ where: { claimId: c.id, side } })) throw bad(`An ${side} appeal is already recorded`, 409);
  const a: any = await M.UiAppeal.create({ claimId: c.id, side, filedDate: fd, notes: txt(q.body.notes, 2000), createdBy: q.user.id } as any); await c.update({ status: 'appealed' });
  await log(q.user.id, 'UI Appeal Recorded', `#${c.id} ${side}`); s.status(201).json(a);
}));
uiInsuranceRouter.post('/ui-claims/:id/close', hr, wrap(async (q, s) => {
  const c: any = await M.UiClaim.findByPk(id(q.params.id)); if (!c) throw bad('Not found', 404); if (c.status === 'closed') throw bad('Already closed', 409);
  const note = txt(q.body.note, 1000); if (c.agencyDecision === 'pending' && note.length < 10) throw bad('No determination is recorded: explain why the claim is being closed (at least 10 characters)');
  await c.update({ status: 'closed', closedAt: new Date(), closeNote: note || null }); await log(q.user.id, 'UI Claim Closed', `#${c.id}`); s.json(view(c));
}));
export async function runUiJob() {
  const t = todayStr(); let reminded = 0, missed = 0;
  for (const c of (await M.UiClaim.findAll({ where: { responseStatus: 'pending' } })) as any[]) {
    if (c.responseDue < t) { await c.update({ responseStatus: 'missed', lateEscalatedAt: new Date() }); await notifyHR('UI response deadline MISSED', `Claim #${c.id}: the employer response was due ${c.responseDue}. Late replies can lose the right to contest: respond now and tell the agency`); missed++; }
    else if (!c.remindedAt && c.responseDue <= addDays(t, 2)) { await c.update({ remindedAt: new Date() }); await notifyHR('UI response due soon', `Claim #${c.id}: response due ${c.responseDue}`); reminded++; }
  }
  return { reminded, missed };
}

// ================= A8 insurance register =================
const money = (v: any, what: string) => { const n = Number(v); if (!(n >= 0)) throw bad(`${what} must be 0 or more`); return Math.round(n * 100) / 100; };
function policyBody(b: any, partial = false) {
  const out: any = {};
  if (!partial || b.type !== undefined) { if (!H.INSURANCE.includes(b.type)) throw bad('Choose one of the 15 policy types'); out.type = b.type; }
  if (!partial || b.insurer !== undefined) { if (!txt(b.insurer, 160)) throw bad('Insurer is required'); out.insurer = txt(b.insurer, 160); }
  if (!partial || b.policyNumber !== undefined) { if (!txt(b.policyNumber, 80)) throw bad('Policy number is required'); out.policyNumber = txt(b.policyNumber, 80); }
  if (!partial || b.coverageLimit !== undefined) out.coverageLimit = money(b.coverageLimit, 'Coverage limit');
  if (!partial || b.premium !== undefined) out.premium = money(b.premium, 'Premium');
  if (!partial || b.premiumFrequency !== undefined) { if (!['monthly', 'quarterly', 'annual'].includes(b.premiumFrequency)) throw bad('Premium frequency: monthly, quarterly or annual'); out.premiumFrequency = b.premiumFrequency; }
  if (!partial || b.effectiveDate !== undefined) { const d = isoDate(b.effectiveDate); if (!d) throw bad('Enter a valid effective date'); out.effectiveDate = d; }
  if (!partial || b.expirationDate !== undefined) { const d = isoDate(b.expirationDate); if (!d) throw bad('Enter a valid expiration date'); out.expirationDate = d; }
  if (b.exclusions !== undefined) out.exclusions = txt(b.exclusions, 5000); if (b.notes !== undefined) out.notes = txt(b.notes, 5000);
  if (b.claimsContact !== undefined) { const c = b.claimsContact || {}; out.claimsContact = { name: txt(c.name, 120), phone: txt(c.phone, 40), email: txt(c.email, 160) }; }
  return out;
}
uiInsuranceRouter.get('/insurance/types', hr, wrap(async (_q, s) => {   // the register: all 15 types, which are covered and which are not
  const ps: any[] = await M.InsurancePolicy.findAll({ where: { status: 'active' }, raw: true });
  s.json(H.INSURANCE.map((t, i) => ({ no: i + 1, type: t, activePolicies: ps.filter((p) => p.type === t).length, note: t === 'Unemployment Insurance' ? 'A state payroll-tax program: record the state account and rate here' : t === 'Employment-Related Practices Liability' ? 'May overlap with EPLI (#3): confirm with your broker' : undefined })));
}));
uiInsuranceRouter.get('/insurance/renewals', hr, wrap(async (_q, s) => {
  const t = todayStr(), ps: any[] = await M.InsurancePolicy.findAll({ where: { status: { [Op.in]: ['active', 'expired'] } }, order: [['expirationDate', 'ASC']], raw: true });
  s.json(ps.map((p) => ({ id: p.id, type: p.type, insurer: p.insurer, policyNumber: p.policyNumber, expirationDate: p.expirationDate, status: p.status, bucket: H.renewalBucket(p.expirationDate, t), daysLeft: Math.round((Date.parse(p.expirationDate) - Date.parse(t)) / 864e5) })));
}));
uiInsuranceRouter.get('/insurance', hr, wrap(async (_q, s) => { const t = todayStr(); s.json(((await M.InsurancePolicy.findAll({ order: [['type', 'ASC'], ['expirationDate', 'ASC']] })) as any[]).map((p) => ({ ...p.toJSON(), bucket: H.renewalBucket(p.expirationDate, t) }))); }));
uiInsuranceRouter.get('/insurance/:id', hr, wrap(async (q, s) => {
  const p: any = await M.InsurancePolicy.findByPk(id(q.params.id)); if (!p) throw bad('Not found', 404);
  const items: any[] = await M.InsuredItem.findAll({ where: { policyId: p.id } }), nm = await names(items.map((i) => i.employeeId));
  s.json({ ...p.toJSON(), bucket: H.renewalBucket(p.expirationDate, todayStr()), insured: items.map((i) => ({ ...i.toJSON(), employeeName: nm.get(i.employeeId) })), documents: await M.InsuranceDocument.findAll({ where: { policyId: p.id } }) });
}));
uiInsuranceRouter.post('/insurance', hr, wrap(async (q, s) => {
  const v = policyBody(q.body); if (v.expirationDate <= v.effectiveDate) throw bad('The expiration date must be after the effective date');
  if (await M.InsurancePolicy.findOne({ where: { type: v.type, policyNumber: v.policyNumber } })) throw bad('This policy number is already recorded for that type', 409);
  const p: any = await M.InsurancePolicy.create({ ...v, createdBy: q.user.id, status: 'active', remindersSent: [] } as any); await log(q.user.id, 'Insurance Policy Added', `#${p.id} ${v.type}`); s.status(201).json(p);
}));
uiInsuranceRouter.patch('/insurance/:id', hr, wrap(async (q, s) => {
  const p: any = await M.InsurancePolicy.findByPk(id(q.params.id)); if (!p) throw bad('Not found', 404);
  const v = policyBody(q.body, true), exp = v.expirationDate ?? p.expirationDate, eff = v.effectiveDate ?? p.effectiveDate; if (exp <= eff) throw bad('The expiration date must be after the effective date');
  const up: any = { ...v }; if (q.body.status !== undefined) { if (!['active', 'cancelled'].includes(q.body.status)) throw bad('Status: active or cancelled'); up.status = q.body.status; }
  if (v.expirationDate && v.expirationDate !== p.expirationDate) { up.remindersSent = []; if (p.status === 'expired') up.status = 'active'; }   // a renewal restarts the reminders
  const before = { limit: p.coverageLimit, premium: p.premium, exp: p.expirationDate }; await p.update(up);
  await log(q.user.id, 'Insurance Policy Updated', `#${p.id} ${JSON.stringify(before)} -> ${JSON.stringify({ limit: p.coverageLimit, premium: p.premium, exp: p.expirationDate })}`); s.json(p);
}));
uiInsuranceRouter.post('/insurance/:id/insured', hr, wrap(async (q, s) => {
  const p: any = await M.InsurancePolicy.findByPk(id(q.params.id)); if (!p) throw bad('Not found', 404);
  if (!['person', 'asset'].includes(q.body.kind)) throw bad('Choose person or asset');
  if (q.body.kind === 'person') { const e: any = await M.Employee.findByPk(id(q.body.employeeId)); if (!e) throw bad('Employee not found', 404); const it: any = await M.InsuredItem.create({ policyId: p.id, kind: 'person', employeeId: e.id, label: e.name, details: txt(q.body.details, 2000) } as any); await log(q.user.id, 'Insured Added', `policy #${p.id} employee #${e.id}`); return s.status(201).json(it); }
  if (!txt(q.body.label, 200)) throw bad('Describe the covered asset (vehicle, building, equipment...)');
  const it: any = await M.InsuredItem.create({ policyId: p.id, kind: 'asset', label: txt(q.body.label, 200), details: txt(q.body.details, 2000) } as any); await log(q.user.id, 'Insured Added', `policy #${p.id} asset`); s.status(201).json(it);
}));
uiInsuranceRouter.delete('/insurance/:id/insured/:iid', hr, wrap(async (q, s) => { const n = await M.InsuredItem.destroy({ where: { id: id(q.params.iid), policyId: id(q.params.id) } }); if (!n) throw bad('Not found', 404); await log(q.user.id, 'Insured Removed', `policy #${q.params.id}`); s.json({ ok: true }); }));
uiInsuranceRouter.post('/insurance/:id/documents', hr, wrap(async (q, s) => {
  const p: any = await M.InsurancePolicy.findByPk(id(q.params.id)); if (!p) throw bad('Not found', 404);
  if (!['certificate', 'policy', 'endorsement', 'claim_form', 'other'].includes(q.body.kind)) throw bad('Choose a document type'); if (!txt(q.body.title, 200)) throw bad('A title is required');
  const d: any = await M.InsuranceDocument.create({ policyId: p.id, kind: q.body.kind, title: txt(q.body.title, 200), reference: txt(q.body.reference, 500), issuedDate: q.body.issuedDate ? isoDate(q.body.issuedDate) : null, addedBy: q.user.id } as any); await log(q.user.id, 'Insurance Document Added', `policy #${p.id} ${q.body.kind}`); s.status(201).json(d);
}));
/** Renewal reminders at 90/60/30/7 days (once per threshold) and automatic expiry with a compliance task. */
export async function runInsuranceJob() {
  const t = todayStr(); let reminders = 0, expired = 0; const ORDER = ['d90', 'd60', 'd30', 'd7'];
  for (const p of (await M.InsurancePolicy.findAll({ where: { status: 'active' } })) as any[]) {
    const b = H.renewalBucket(p.expirationDate, t), sent: string[] = p.remindersSent || [];
    if (b === 'expired') { await p.update({ status: 'expired' }); await M.ComplianceTask.create({ employeeId: p.createdBy, type: `Insurance expired: ${p.type} (${p.policyNumber})`, dueDate: p.expirationDate, status: 'overdue' } as any); await notifyHR('Insurance policy expired', `${p.type} (${p.policyNumber}) expired on ${p.expirationDate}`); expired++; }
    else if (b !== 'ok' && !sent.includes(b)) { await p.update({ remindersSent: [...sent, ...ORDER.slice(0, ORDER.indexOf(b) + 1)].filter((x, i, a) => a.indexOf(x) === i) }); await notifyHR('Insurance renewal coming up', `${p.type} (${p.policyNumber}) expires ${p.expirationDate}`); reminders++; }
  }
  return { reminders, expired };
}
