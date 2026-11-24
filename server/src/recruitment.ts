import { runAs, runSystem, currentCtx } from './tenancy';
import { Router } from 'express';
import { Op } from 'sequelize';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import * as M from './models';
import { log, SALARY_FLOOR, sickHours, isHR, isStaff } from './services';
import { wrap, bad, hr, staff } from './http';
import { notify, startOnboarding } from './lifecycle';
import { sendMail, mailConfigured } from './mail';
import * as R from './recruitmentCore';
import fs from 'node:fs';
import path from 'node:path';

export const recruitmentRouter = Router();   // behind auth
export const careersRouter = Router();       // public: job list + apply (no login). Company comes from the URL slug (P14).
careersRouter.use('/public/:slug', (q: any, s: any, n: any) => {
  runSystem(() => M.Company.findOne({ where: { slug: q.params.slug, status: 'active' } })).then((c: any) => {
    if (!c) return s.status(404).json({ error: 'Company not found' });
    q.company = c; runAs(c.id, async () => n());
  }).catch(n);
});
async function companyName() { const id = currentCtx()?.companyId; const c: any = id ? await M.Company.findByPk(id) : null; return c?.name || COMPANY; }

const COMPANY = process.env.COMPANY_NAME || 'AMS';
const CHANNELS = ['Careers page', 'Job boards', 'Professional network', 'Staffing agency', 'Referrals', 'Social media'];
export const SOURCES = [...CHANNELS, 'Direct', 'Other'];
export const COMPETENCIES = [
  { key: 'role', label: 'Role knowledge' }, { key: 'problem', label: 'Problem solving' }, { key: 'communication', label: 'Communication' },
  { key: 'teamwork', label: 'Collaboration' }, { key: 'motivation', label: 'Motivation for this role' },
];
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/, PHONE = /^[0-9+()\-. ]{7,30}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const J = (v: any, d: any = null) => { if (v == null) return d; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return d; } } return v; };
const str = (v: any, min: number, max: number, label: string) => { const t = String(v ?? '').trim(); if (t.length < min || t.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) throw bad(`${label}: ${min}-${max} characters`); return t; };
const num = (v: any, label: string, min = 0.01) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > 10_000_000) throw bad(`${label} is not valid`); return Math.round(n * 100) / 100; };
const hrIds = async () => ((await M.Employee.findAll({ where: { role: { [Op.in]: ['hr', 'admin'] }, status: { [Op.ne]: 'terminated' } }, attributes: ['id'], raw: true })) as any[]).map((x) => x.id);
const nameMap = async (ids: number[]) => new Map(((await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids.filter(Boolean))] } }, attributes: ['id', 'name'], raw: true })) as any[]).map((x) => [x.id, x.name]));

async function getReq(id: any): Promise<any> { const r: any = await M.Requisition.findByPk(Number(id)); if (!r) throw bad('Requisition not found', 404); return r; }
const ownsReq = (u: any, r: any) => isHR(u) || r.requestedBy === u.id;
const reqJson = (r: any) => ({ ...r.toJSON(), minQuals: J(r.minQuals, []), questions: J(r.questions, []), criteria: J(r.criteria, R.DEFAULT_CRITERIA), channels: J(r.channels, []) });
async function getCand(id: any, u: any): Promise<{ c: any; r: any }> {
  const c: any = await M.Candidate.findByPk(Number(id)); if (!c) throw bad('Candidate not found', 404);
  const r: any = c.requisitionId ? await M.Requisition.findByPk(c.requisitionId) : null;
  if (!isHR(u) && !(u.role === 'manager' && r && r.requestedBy === u.id)) throw bad('Not allowed for your role', 403);
  return { c, r };
}
async function queue(c: any, kind: R.MsgKind, vars: Record<string, any>, by: number) {
  if (!c.email) return null;
  const t = R.template(kind, { company: await companyName(), name: c.name, role: c.position, accommodation: process.env.HR_CONTACT || 'our HR team', ...vars });
  return M.CandidateMessage.create({ candidateId: c.id, kind, toEmail: c.email, subject: t.subject, body: t.body, createdBy: by } as any);
}
async function setStage(c: any, to: R.Stage, actor: number, reason = '', extra: any = {}) {
  const from = c.stage; await c.update({ stage: to, ...extra });
  await M.StageHistory.create({ candidateId: c.id, fromStage: from, toStage: to, actorId: actor, reason: reason.slice(0, 500) } as any);
  await log(actor, 'Candidate Stage Changed', `#${c.id} ${from} -> ${to}`);
}

// ======================================================================
// Public careers page: list open jobs, apply (S1 intake)
// ======================================================================
const publicJob = (r: any) => ({ id: r.id, title: r.title, department: r.department, state: r.workState, city: r.city, employmentType: r.employmentType, payType: r.payType,
  payMin: r.payMin == null ? null : Number(r.payMin), payMax: r.payMax == null ? null : Number(r.payMax), description: r.description, minQuals: J(r.minQuals, []), questions: J(r.questions, []), postedAt: r.postedAt, closesAt: r.closesAt, equalOpportunity: true, accommodationContact: process.env.HR_CONTACT || 'HR team' });
const openWhere = () => ({ status: 'open', [Op.or]: [{ closesAt: null }, { closesAt: { [Op.gte]: today() } }] });
careersRouter.get('/public/:slug/jobs', wrap(async (_q, s) => s.json((await M.Requisition.findAll({ where: openWhere() as any, order: [['postedAt', 'DESC']], limit: 100 })).map(publicJob))));
careersRouter.get('/public/:slug/jobs/:id', wrap(async (q, s) => { const r: any = await M.Requisition.findOne({ where: { id: Number(q.params.id) || 0, ...(openWhere() as any) } }); if (!r) throw bad('This job is no longer open', 404); s.json(publicJob(r)); }));
const applyLimiter = process.env.NODE_ENV === 'test' ? (_q: any, _s: any, n: any) => n() : rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

/** Validates and stores an application. `byRecruiter` skips the candidate consent step (the recruiter adds a referral or agency candidate). */
async function createCandidate(reqRow: any, b: any, source: string, byRecruiter: number | null) {
  if (!reqRow || reqRow.status !== 'open') throw bad('This job is no longer open', 404);
  const name = str(b.name, 2, 120, 'Name'), email = String(b.email || '').toLowerCase().trim();
  if (!EMAIL.test(email) || email.length > 160) throw bad('Enter a valid email address');
  const phone = String(b.phone || '').trim(); if (phone && !PHONE.test(phone)) throw bad('Phone number is not valid');
  const resumeRef = str(b.resumeRef, 3, 500, 'Resume link or file name');
  if (resumeRef.startsWith('file:')) {   // uploaded file: must be one we stored (see POST /public/resume)
    const dir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'resumes');
    if (!/^file:[a-f0-9]{32}\.(pdf|docx|doc)$/.test(resumeRef) || !fs.existsSync(path.join(dir, resumeRef.slice(5)))) throw bad('The uploaded resume was not found. Please upload it again');
  }
  if (typeof b.workAuthorized !== 'boolean' || typeof b.needsSponsorship !== 'boolean') throw bad('Answer both work authorization questions');
  if (!byRecruiter && b.consent !== true) throw bad('Please accept the privacy notice to apply');
  const history: R.HistoryItem[] = (Array.isArray(b.history) ? b.history : []).slice(0, 8).map((h: any) => ({ employer: str(h?.employer, 2, 120, 'Employer'), title: str(h?.title, 2, 120, 'Job title'), start: String(h?.start || '').slice(0, 10), end: String(h?.end || '').slice(0, 10), status: 'unverified' as const }));
  const qs: string[] = J(reqRow.questions, []); const answers: Record<string, string> = {};
  for (let i = 0; i < qs.length; i++) answers[String(i)] = str(b.answers?.[i], 1, 1000, `Answer to question ${i + 1}`);
  const dup = await M.Candidate.findOne({ where: { email, requisitionId: reqRow.id } }); if (dup) throw bad('This email has already applied for this job', 409);
  const prior: any = await M.Candidate.findOne({ where: { email }, order: [['id', 'ASC']] });
  const c: any = await M.Candidate.create({ name, email, phone: phone || null, position: reqRow.title, requisitionId: reqRow.id, source, resumeRef, workAuthorized: b.workAuthorized, needsSponsorship: b.needsSponsorship,
    history, answers, consentAt: byRecruiter ? null : new Date(), duplicateOf: prior?.id ?? null, stage: 'received' } as any);
  await M.StageHistory.create({ candidateId: c.id, fromStage: null, toStage: 'received', actorId: byRecruiter || 0, reason: byRecruiter ? 'Added by recruiter' : `Applied via ${source}` } as any);
  await queue(c, 'application_received', {}, byRecruiter || 0);
  await notify([...(await hrIds()), reqRow.requestedBy], 'recruitment', `New application: ${name}`, `${reqRow.title}${prior ? ' (same email applied before)' : ''}`, 'candidate', c.id);
  await log(byRecruiter || 0, 'Application Received', `#${c.id} ${reqRow.title}`);
  return c;
}
careersRouter.post('/public/:slug/jobs/:id/apply', applyLimiter, wrap(async (q, s) => {
  if (q.body?.website) return s.json({ ok: true });                         // honeypot: bots fill the hidden field
  const r: any = await M.Requisition.findOne({ where: { id: Number(q.params.id) || 0, ...(openWhere() as any) } });
  const source = SOURCES.includes(q.body?.source) ? q.body.source : 'Careers page';
  await createCandidate(r, q.body || {}, source, null); s.json({ ok: true });
}));

// ======================================================================
// Requisitions (S1)
// ======================================================================
recruitmentRouter.get('/requisitions', staff, wrap(async (q, s) => {
  const rows: any[] = await M.Requisition.findAll({ where: isHR(q.user) ? {} : { requestedBy: q.user.id }, order: [['id', 'DESC']] });
  const counts: any[] = await M.Candidate.findAll({ attributes: ['requisitionId', [M.sequelize.fn('COUNT', M.sequelize.col('id')), 'n']], where: { requisitionId: { [Op.in]: rows.map((x) => x.id) }, stage: { [Op.notIn]: ['rejected'] } }, group: ['requisitionId'], raw: true });
  const n = new Map(counts.map((x) => [x.requisitionId, Number(x.n)])); const nm = await nameMap(rows.map((x) => x.requestedBy));
  s.json(rows.map((r) => ({ ...reqJson(r), activeCandidates: n.get(r.id) || 0, requesterName: nm.get(r.requestedBy) })));
}));
recruitmentRouter.post('/requisitions', staff, wrap(async (q, s) => {
  const b = q.body || {}; const state = String(b.workState || '').toUpperCase();
  if (!STATES.includes(state)) throw bad('Choose a work state');
  const employmentType = ['full_time', 'part_time'].includes(b.employmentType) ? b.employmentType : 'full_time', payType = b.payType === 'hourly' ? 'hourly' : 'salary';
  const payMin = b.payMin === '' || b.payMin == null ? null : num(b.payMin, 'Minimum pay'), payMax = b.payMax === '' || b.payMax == null ? null : num(b.payMax, 'Maximum pay');
  if ((payMin == null) !== (payMax == null)) throw bad('Enter both a minimum and a maximum pay, or neither');
  if (payMin != null && payMax != null && payMax < payMin) throw bad('Maximum pay cannot be below the minimum');
  const quals = (Array.isArray(b.minQuals) ? b.minQuals : []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 10); quals.forEach((x: string) => str(x, 3, 200, 'Qualification'));
  const questions = (Array.isArray(b.questions) ? b.questions : []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 8);
  for (const x of questions) { const why = R.checkQuestion(x); if (why) throw bad(`"${x.slice(0, 60)}": ${why}`); }
  const r: any = await M.Requisition.create({ title: str(b.title, 3, 160, 'Job title'), department: str(b.department, 2, 80, 'Department'), workState: state, city: String(b.city || '').trim().slice(0, 80) || null, employmentType, payType, payMin, payMax,
    headcount: Math.min(50, Math.max(1, Math.floor(Number(b.headcount) || 1))), justification: str(b.justification, 10, 1000, 'Headcount justification'), description: str(b.description, 20, 8000, 'Job description'),
    minQuals: quals, questions, criteria: R.DEFAULT_CRITERIA, status: 'draft', requestedBy: q.user.id } as any);
  await log(q.user.id, 'Requisition Created', `#${r.id} ${r.title}`); s.status(201).json(reqJson(r));
}));
recruitmentRouter.post('/requisitions/:id/submit', staff, wrap(async (q, s) => {
  const r = await getReq(q.params.id); if (!ownsReq(q.user, r)) throw bad('Not allowed for your role', 403);
  if (!['draft', 'rejected'].includes(r.status)) throw bad('Only a draft or returned requisition can be submitted', 409);
  await r.update({ status: 'pending_approval', decisionNote: null }); await notify(await hrIds(), 'recruitment', `Requisition to approve: ${r.title}`, r.justification, 'requisition', r.id); await log(q.user.id, 'Requisition Submitted', `#${r.id}`); s.json({ ok: true });
}));
recruitmentRouter.post('/requisitions/:id/decision', hr, wrap(async (q, s) => {
  const r = await getReq(q.params.id); if (r.status !== 'pending_approval') throw bad('This requisition is not waiting for approval', 409);
  if (r.requestedBy === q.user.id) throw bad('You cannot approve your own requisition', 403);   // separation of duties
  const approve = q.body?.approve === true, note = String(q.body?.comment || '').trim().slice(0, 500); if (!approve && note.length < 3) throw bad('Add a comment when returning a requisition');
  await r.update({ status: approve ? 'approved' : 'rejected', decidedBy: q.user.id, decidedAt: new Date(), decisionNote: note || null });
  await notify([r.requestedBy], 'recruitment', `Requisition ${approve ? 'approved' : 'returned'}: ${r.title}`, note, 'requisition', r.id); await log(q.user.id, approve ? 'Requisition Approved' : 'Requisition Returned', `#${r.id}`); s.json({ ok: true });
}));
recruitmentRouter.post('/requisitions/:id/publish', hr, wrap(async (q, s) => {
  const r = await getReq(q.params.id); if (!['approved', 'on_hold'].includes(r.status)) throw bad('Only an approved requisition can be published', 409);
  const channels = (Array.isArray(q.body?.channels) ? q.body.channels : []).filter((c: any) => CHANNELS.includes(c)); if (!channels.length) throw bad('Choose at least one advertising channel');
  if (R.payRangeRequired(r.workState) && (r.payMin == null || r.payMax == null)) throw bad(`${r.workState} requires a pay range in job postings. Add the range to the requisition first.`);
  const closes = q.body?.closesAt ? String(q.body.closesAt) : null; if (closes && (!DATE.test(closes) || closes < today())) throw bad('Closing date is not valid');
  await r.update({ status: 'open', channels, postedAt: r.postedAt || new Date(), closesAt: closes }); await log(q.user.id, 'Requisition Published', `#${r.id} ${channels.join(', ')}`); s.json({ ok: true });
}));
recruitmentRouter.post('/requisitions/:id/close', hr, wrap(async (q, s) => {
  const r = await getReq(q.params.id); const to = q.body?.to; if (!['closed', 'on_hold'].includes(to)) throw bad('Unknown status');
  if (!['open', 'on_hold', 'approved'].includes(r.status)) throw bad('This requisition cannot be changed now', 409); await r.update({ status: to }); await log(q.user.id, 'Requisition ' + to, `#${r.id}`); s.json({ ok: true });
}));

// ======================================================================
// Candidates: list, detail, add, screen (S2), history checks, stage moves
// ======================================================================
recruitmentRouter.get('/candidates', staff, wrap(async (q, s) => {
  const where: any = {}; if (!isHR(q.user)) { const mine = ((await M.Requisition.findAll({ where: { requestedBy: q.user.id }, attributes: ['id'], raw: true })) as any[]).map((x) => x.id); where.requisitionId = { [Op.in]: mine.length ? mine : [0] }; }
  if (q.query.requisitionId) where.requisitionId = Number(q.query.requisitionId) || 0; if (q.query.stage && (R.STAGES as readonly string[]).includes(String(q.query.stage))) where.stage = q.query.stage;
  const term = String(q.query.q || '').trim().slice(0, 60); if (term) { const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`; where[Op.or] = [{ name: { [Op.like]: like } }, { email: { [Op.like]: like } }]; }
  const rows: any[] = await M.Candidate.findAll({ where, order: [['id', 'DESC']], limit: 300 });
  const ivs: any[] = await M.Interview.findAll({ where: { candidateId: { [Op.in]: rows.map((x) => x.id) }, status: 'scheduled' }, attributes: ['candidateId', 'scheduledAt'], raw: true });
  const next = new Map<number, string>(); ivs.forEach((i) => { if (!next.has(i.candidateId) || +new Date(i.scheduledAt) < +new Date(next.get(i.candidateId)!)) next.set(i.candidateId, i.scheduledAt); });
  s.json(rows.map((c) => ({ id: c.id, name: c.name, email: c.email, position: c.position, requisitionId: c.requisitionId, stage: c.stage, source: c.source, createdAt: c.createdAt, score: J(c.screening)?.score ?? null, duplicate: !!c.duplicateOf, nextInterview: next.get(c.id) || null, rejectReason: c.rejectReason })));
}));
recruitmentRouter.post('/candidates', hr, wrap(async (q, s) => {
  const r = await getReq(q.body?.requisitionId); const source = SOURCES.includes(q.body?.source) ? q.body.source : 'Other';
  const c = await createCandidate(r, q.body || {}, source, q.user.id); s.status(201).json({ id: c.id });
}));
recruitmentRouter.get('/candidates/:id/resume', staff, wrap(async (q, s) => {
  const { c } = await getCand(q.params.id, q.user);                          // same scope rules as the candidate page
  if (!/^file:[a-f0-9]{32}\.(pdf|docx|doc)$/.test(String(c.resumeRef || ''))) throw bad('This candidate has no uploaded resume', 404);
  const dir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'resumes'), f = String(c.resumeRef).slice(5);
  if (!fs.existsSync(path.join(dir, f))) throw bad('Resume file is missing on the server', 404);
  await log(q.user.id, 'Resume Viewed', `candidate #${c.id}`); s.download(path.join(dir, f), `resume-${c.id}.${f.split('.').pop()}`);
}));
recruitmentRouter.get('/candidates/:id', staff, wrap(async (q, s) => {
  const { c, r } = await getCand(q.params.id, q.user), hrUser = isHR(q.user);
  const ivs: any[] = await M.Interview.findAll({ where: { candidateId: c.id }, order: [['scheduledAt', 'ASC']] });
  const cards: any[] = await M.Scorecard.findAll({ where: { candidateId: c.id }, raw: true });
  const sh: any[] = await M.StageHistory.findAll({ where: { candidateId: c.id }, order: [['id', 'ASC']], raw: true });
  const offers: any[] = await M.Offer.findAll({ where: { candidateId: c.id }, order: [['id', 'DESC']], raw: true });
  const bg: any = hrUser ? await M.BackgroundCheck.findOne({ where: { candidateId: c.id }, raw: true }) : null;
  const msgs: any[] = hrUser ? await M.CandidateMessage.findAll({ where: { candidateId: c.id }, order: [['id', 'DESC']], raw: true }) : [];
  const names = await nameMap([...sh.map((x) => x.actorId), ...cards.map((x) => x.interviewerId), ...ivs.flatMap((i) => J(i.panel, []))]);
  const visible = ivs.map((i) => { const panel: number[] = J(i.panel, []), mine = cards.find((x) => x.interviewId === i.id && x.interviewerId === q.user.id);
    const blind = panel.includes(q.user.id) && !mine;      // S3: score independently before seeing colleagues' scores
    return { ...i.toJSON(), panel: panel.map((id) => ({ id, name: names.get(id) })), cardsHidden: blind, scorecards: blind ? [] : cards.filter((x) => x.interviewId === i.id).map((x) => ({ ...x, scores: J(x.scores, {}), interviewerName: names.get(x.interviewerId) })) }; });
  const shown = visible.flatMap((v: any) => v.scorecards);
  s.json({ candidate: { ...c.toJSON(), history: J(c.history, []), answers: J(c.answers, {}), screening: J(c.screening) }, requisition: r ? reqJson(r) : null, interviews: visible, competencies: COMPETENCIES,
    panel: R.panelSummary(shown), readiness: R.interviewReadiness(cards), offers, background: bg, messages: msgs.map((m) => ({ ...m, body: m.body })),
    timeline: sh.map((x) => ({ ...x, actorName: x.actorId ? names.get(x.actorId) : 'Applicant' })), allowed: (R.canMove(c.stage, 'interview') ? ['interview'] : []).concat(R.STAGES.filter((t) => t !== 'hired' && t !== 'interview' && R.canMove(c.stage, t))) });
}));
recruitmentRouter.post('/candidates/:id/screen', hr, wrap(async (q, s) => {
  const { c, r } = await getCand(q.params.id, q.user); if (!['received', 'screening'].includes(c.stage)) throw bad('Screening is only done while the candidate is Received or Screening', 409);
  const crit: R.Criterion[] = J(r?.criteria, R.DEFAULT_CRITERIA), quals: string[] = J(r?.minQuals, []);
  let score: number; try { score = R.weightedScore(crit, q.body?.ratings || {}); } catch (e: any) { throw bad(e.message); }
  const checks = quals.map((_, i) => q.body?.checks?.[i] === true); const rationale = str(q.body?.rationale, 10, 1000, 'Job-related rationale');
  const ratings: any = {}; crit.forEach((k) => (ratings[k.key] = Number(q.body.ratings[k.key])));
  await c.update({ screening: { ratings, score, checks, meetsAll: checks.every(Boolean), rationale, reviewerId: q.user.id, at: new Date().toISOString() } });
  if (c.stage === 'received') await setStage(c, 'screening', q.user.id, 'Screening started'); await log(q.user.id, 'Candidate Screened', `#${c.id} score ${score}`); s.json({ score, meetsAll: checks.every(Boolean) });
}));
recruitmentRouter.post('/candidates/:id/history/:idx', hr, wrap(async (q, s) => {
  const { c } = await getCand(q.params.id, q.user), h: R.HistoryItem[] = J(c.history, []), i = Number(q.params.idx); if (!Number.isInteger(i) || !h[i]) throw bad('History item not found', 404);
  const st = q.body?.status; if (!['unverified', 'verified', 'discrepancy'].includes(st)) throw bad('Unknown status');
  h[i] = { ...h[i], status: st, note: String(q.body?.note ?? h[i].note ?? '').trim().slice(0, 500), clarification: String(q.body?.clarification ?? h[i].clarification ?? '').trim().slice(0, 500) };
  await c.update({ history: h }); await log(q.user.id, 'Work History Checked', `#${c.id} item ${i} ${st}`); s.json({ ok: true });
}));

recruitmentRouter.post('/candidates/:id/move', staff, wrap(async (q, s) => {
  const { c, r } = await getCand(q.params.id, q.user), to = q.body?.to as R.Stage, from = c.stage as R.Stage, hrUser = isHR(q.user);
  if (!(R.STAGES as readonly string[]).includes(to) || to === 'hired') throw bad('Unknown stage (a candidate becomes Hired only when an offer is accepted)');
  if (!R.canMove(from, to)) throw bad(`A candidate cannot move from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}`, 409);
  const mgrOk = (from === 'interview' && (to === 'offer' || to === 'rejected'));   // the hiring manager decides "Approve candidate?" for their own requisition
  if (!hrUser && !mgrOk) throw bad('Only HR can make this move', 403);
  if (['interview', 'offer'].includes(to) && r && ['closed', 'filled'].includes(r.status)) throw bad('This position is closed or filled', 409);
  const reason = String(q.body?.reason || ''), note = String(q.body?.note || '').trim().slice(0, 500);
  if (to === 'interview' && from === 'screening') { const sc = J(c.screening); if (!sc) throw bad('Complete the screening rubric first', 409); if (!sc.meetsAll) throw bad('Minimum qualifications are not all met. Reject or hold instead.', 409); }
  const bg: any = await M.BackgroundCheck.findOne({ where: { candidateId: c.id } });
  if (to === 'offer') {
    const cards: any[] = await M.Scorecard.findAll({ where: { candidateId: c.id }, raw: true }); const ready = R.interviewReadiness(cards); if (!ready.ok) throw bad(ready.reason!, 409);
    if (bg && ['pre_adverse', 'adverse'].includes(bg.status)) throw bad('A background check adverse action is in progress for this candidate', 409);
  }
  if (to === 'rejected') {
    if (!R.REJECT_REASONS[reason] || reason === 'offer_declined') throw bad('Choose a rejection reason');
    if (reason === 'verification_discrepancy' && !R.canRejectForDiscrepancy(J(c.history, []))) throw bad('Do not reject on an unexplained discrepancy: record the candidate\u2019s clarification for each discrepancy first', 409);
    if (reason === 'background_result' && bg?.status !== 'adverse') throw bad('Finish the FCRA adverse action steps before rejecting on a background result', 409);
  }
  if (from === 'offer') await M.Offer.update({ status: 'withdrawn' }, { where: { candidateId: c.id, status: { [Op.in]: ['pending_approval', 'approved', 'sent'] } } });
  if (to === 'rejected') {
    await M.Interview.update({ status: 'cancelled' }, { where: { candidateId: c.id, status: 'scheduled' } }); await M.Offer.update({ status: 'withdrawn' }, { where: { candidateId: c.id, status: { [Op.in]: ['pending_approval', 'approved', 'sent'] } } });
    if (!['withdrew', 'no_response', 'background_result'].includes(reason)) await queue(c, 'rejection', {}, q.user.id);
    await setStage(c, to, q.user.id, R.REJECT_REASONS[reason] + (note ? `: ${note}` : ''), { rejectReason: reason, rejectedAt: new Date() });
  } else await setStage(c, to, q.user.id, note);
  if (to === 'offer') await notify(await hrIds(), 'recruitment', `Ready for offer: ${c.name}`, `${c.position}: prepare the offer terms.`, 'candidate', c.id);
  s.json({ ok: true, stage: to });
}));

// ======================================================================
// Interviews and scorecards (S3)
// ======================================================================
recruitmentRouter.post('/candidates/:id/interviews', hr, wrap(async (q, s) => {
  const { c } = await getCand(q.params.id, q.user); if (c.stage !== 'interview') throw bad('Move the candidate to Interview first', 409);
  const when = new Date(q.body?.scheduledAt); if (isNaN(+when) || +when < Date.now() - 60_000) throw bad('Choose a date and time in the future');
  const panel = [...new Set((Array.isArray(q.body?.panel) ? q.body.panel : []).map(Number))].filter((x: any) => Number.isInteger(x)) as number[]; if (!panel.length || panel.length > 6) throw bad('Choose 1 to 6 interviewers');
  const emps: any[] = await M.Employee.findAll({ where: { id: { [Op.in]: panel }, status: { [Op.ne]: 'terminated' } }, attributes: ['id', 'name'], raw: true }); if (emps.length !== panel.length) throw bad('One of the interviewers is not an active employee');
  const format = ['phone', 'video', 'onsite'].includes(q.body?.format) ? q.body.format : 'video', where = String(q.body?.location || '').trim().slice(0, 300), tz = String(q.body?.tz || '').trim().slice(0, 40);
  const iv: any = await M.Interview.create({ candidateId: c.id, requisitionId: c.requisitionId, scheduledAt: when, format, location: where || null, panel, accommodationContact: process.env.HR_CONTACT || 'HR team', createdBy: q.user.id } as any);
  await queue(c, 'interview_invite', { when: when.toUTCString().replace(':00 GMT', ' UTC'), tz, format, where, panel: emps.map((e) => e.name).join(', '), accommodation: iv.accommodationContact }, q.user.id);
  await notify(panel, 'recruitment', `Interview: ${c.name}`, `${c.position} on ${when.toUTCString()}. Submit your scorecard before the group discussion.`, 'candidate', c.id); await log(q.user.id, 'Interview Scheduled', `#${iv.id} candidate #${c.id}`); s.status(201).json({ id: iv.id });
}));
recruitmentRouter.post('/interviews/:id/cancel', hr, wrap(async (q, s) => { const iv: any = await M.Interview.findByPk(Number(q.params.id)); if (!iv) throw bad('Not found', 404); if (iv.status !== 'scheduled') throw bad('Only a scheduled interview can be cancelled', 409); await iv.update({ status: 'cancelled' }); await log(q.user.id, 'Interview Cancelled', `#${iv.id}`); s.json({ ok: true }); }));
recruitmentRouter.get('/my/interviews', wrap(async (q, s) => {
  const ivs: any[] = await M.Interview.findAll({ where: { status: { [Op.ne]: 'cancelled' } }, order: [['scheduledAt', 'ASC']], limit: 300 }); const mine = ivs.filter((i) => J(i.panel, []).includes(q.user.id));
  const cands: any[] = await M.Candidate.findAll({ where: { id: { [Op.in]: mine.map((i) => i.candidateId) } }, attributes: ['id', 'name', 'position'], raw: true }); const cm = new Map(cands.map((x) => [x.id, x]));
  const done: any[] = await M.Scorecard.findAll({ where: { interviewerId: q.user.id, interviewId: { [Op.in]: mine.map((i) => i.id) } }, raw: true }); const dm = new Map(done.map((x) => [x.interviewId, x]));
  s.json({ competencies: COMPETENCIES, interviews: mine.map((i) => ({ id: i.id, scheduledAt: i.scheduledAt, format: i.format, location: i.location, status: i.status, candidate: cm.get(i.candidateId), submitted: dm.has(i.id), myCard: dm.get(i.id) ? { ...dm.get(i.id), scores: J(dm.get(i.id).scores, {}) } : null })) });
}));
recruitmentRouter.post('/interviews/:id/scorecard', wrap(async (q, s) => {
  const iv: any = await M.Interview.findByPk(Number(q.params.id)); if (!iv) throw bad('Not found', 404);
  const panel: number[] = J(iv.panel, []); if (!panel.includes(q.user.id)) throw bad('You are not on this interview panel', 403); if (iv.status === 'cancelled') throw bad('This interview was cancelled', 409);
  const scores: any = {}; let sum = 0;
  for (const k of COMPETENCIES) { const v = Number(q.body?.scores?.[k.key]); if (!Number.isInteger(v) || v < 1 || v > 5) throw bad(`Rate "${k.label}" from 1 to 5`); scores[k.key] = v; sum += v; }
  const rec = q.body?.recommendation; if (!(rec in R.REC)) throw bad('Choose a recommendation'); const notes = str(q.body?.notes, 10, 2000, 'Evidence notes (job-related, no personal characteristics)');
  if (await M.Scorecard.findOne({ where: { interviewId: iv.id, interviewerId: q.user.id } })) throw bad('You already submitted a scorecard for this interview', 409);
  const total = Math.round(((sum / COMPETENCIES.length - 1) / 4) * 1000) / 10;
  await M.Scorecard.create({ interviewId: iv.id, candidateId: iv.candidateId, interviewerId: q.user.id, scores, total, recommendation: rec, notes } as any);
  const n = await M.Scorecard.count({ where: { interviewId: iv.id } }); if (n >= panel.length) await iv.update({ status: 'completed' });
  const r: any = await M.Requisition.findByPk(iv.requisitionId); await notify([...(await hrIds()), r?.requestedBy], 'recruitment', 'Scorecard submitted', `Interview #${iv.id}: ${n} of ${panel.length} scorecards are in.`, 'candidate', iv.candidateId); await log(q.user.id, 'Scorecard Submitted', `#${iv.id}`); s.status(201).json({ total, all: n >= panel.length });
}));
recruitmentRouter.get('/interviewers', hr, wrap(async (_q, s) => s.json(await M.Employee.findAll({ where: { status: { [Op.ne]: 'terminated' } }, attributes: ['id', 'name', 'title', 'department'], order: [['name', 'ASC']], raw: true }))));

// ======================================================================
// Offers (S3) and hire -> onboarding (P6 -> P5)
// ======================================================================
const offerVars = (o: any, c: any, r: any, mgr?: string) => ({ title: o.title, pay: R.payText(o), startDate: o.startDate, deadline: o.deadline, location: `${r?.city ? r.city + ', ' : ''}${r?.workState || ''}`, manager: mgr, contingencies: o.contingencies, role: c.position });
recruitmentRouter.post('/candidates/:id/offer', hr, wrap(async (q, s) => {
  const { c, r } = await getCand(q.params.id, q.user); if (c.stage !== 'offer') throw bad('Move the candidate to Offer first', 409); if (!r || !['open', 'on_hold', 'approved'].includes(r.status)) throw bad('This position is closed or filled', 409);
  if (await M.Offer.findOne({ where: { candidateId: c.id, status: { [Op.in]: ['pending_approval', 'approved', 'sent'] } } })) throw bad('An offer is already in progress', 409);
  const b = q.body || {}, payType = b.payType === 'hourly' ? 'hourly' : 'salary', rate = num(b.rate, 'Pay'), start = String(b.startDate || ''), deadline = String(b.deadline || '');
  if (!DATE.test(start) || start < today()) throw bad('Start date must be today or later'); if (!DATE.test(deadline) || deadline < today() || deadline > start) throw bad('Response deadline must be between today and the start date');
  const exempt = b.flsaExempt === true && payType === 'salary', floor = Math.max(SALARY_FLOOR.US, SALARY_FLOOR[r.workState] || 0);
  if (b.flsaExempt === true && payType !== 'salary') throw bad('Only a salaried role can be exempt from overtime');
  if (exempt && rate < floor) throw bad(`Exempt salary must be at least $${floor.toLocaleString()} a year in ${r.workState}`);
  if (r.payMin != null && payType === r.payType && (rate < Number(r.payMin) || rate > Number(r.payMax))) throw bad(`Offer is outside the posted pay range ($${Number(r.payMin).toLocaleString()} to $${Number(r.payMax).toLocaleString()}). Update the requisition range first.`);
  const o: any = await M.Offer.create({ candidateId: c.id, requisitionId: r.id, title: String(b.title || r.title).trim().slice(0, 160), payType, rate, flsaExempt: exempt, startDate: start, deadline, contingencies: String(b.contingencies || '').trim().slice(0, 500) || null, createdBy: q.user.id } as any);
  await notify([r.requestedBy], 'recruitment', `Approve offer terms: ${c.name}`, R.payText(o), 'candidate', c.id); await log(q.user.id, 'Offer Drafted', `#${o.id} candidate #${c.id}`); s.status(201).json({ id: o.id });
}));
async function getOffer(id: any, u: any) { const o: any = await M.Offer.findByPk(Number(id)); if (!o) throw bad('Offer not found', 404); const { c, r } = await getCand(o.candidateId, u); return { o, c, r }; }
recruitmentRouter.post('/offers/:id/approve', staff, wrap(async (q, s) => {
  const { o, c, r } = await getOffer(q.params.id, q.user); if (o.status !== 'pending_approval') throw bad('This offer is not waiting for approval', 409);
  if (o.createdBy === q.user.id) throw bad('Someone else must approve the offer terms', 403); if (!ownsReq(q.user, r)) throw bad('Only the hiring manager or HR can approve', 403);
  const ok = q.body?.approve === true; if (!ok) { await o.update({ status: 'withdrawn' }); await log(q.user.id, 'Offer Returned', `#${o.id}`); return s.json({ ok: true }); }
  await o.update({ status: 'approved', approvedBy: q.user.id, approvedAt: new Date() }); await notify(await hrIds(), 'recruitment', `Offer approved: ${c.name}`, 'You can send the offer letter now.', 'candidate', c.id); await log(q.user.id, 'Offer Approved', `#${o.id}`); s.json({ ok: true });
}));
recruitmentRouter.post('/offers/:id/send', hr, wrap(async (q, s) => {
  const { o, c, r } = await getOffer(q.params.id, q.user); if (o.status !== 'approved') throw bad('Only an approved offer can be sent', 409);
  const bg: any = await M.BackgroundCheck.findOne({ where: { candidateId: c.id } }); if (bg && ['pre_adverse', 'adverse'].includes(bg.status)) throw bad('A background check adverse action is in progress', 409);
  const mgr = (await nameMap([r.requestedBy])).get(r.requestedBy); await queue(c, 'offer', offerVars(o, c, r, mgr), q.user.id); await o.update({ status: 'sent', sentAt: new Date() }); await log(q.user.id, 'Offer Sent', `#${o.id}`); s.json({ ok: true });
}));
recruitmentRouter.post('/offers/:id/respond', hr, wrap(async (q, s) => {
  const { o, c, r } = await getOffer(q.params.id, q.user); if (o.status !== 'sent') throw bad('This offer has not been sent or was already answered', 409);
  if (o.deadline < today()) { await o.update({ status: 'expired' }); throw bad('The response deadline has passed: the offer expired. Draft a new offer if you still want to hire.', 409); }
  if (q.body?.accepted !== true) {
    await o.update({ status: 'declined', respondedAt: new Date() }); await setStage(c, 'rejected', q.user.id, R.REJECT_REASONS.offer_declined, { rejectReason: 'offer_declined', rejectedAt: new Date() });
    await notify([r.requestedBy, ...(await hrIds())], 'recruitment', `Offer declined: ${c.name}`, `${c.position}. Review the shortlist or reopen sourcing.`, 'candidate', c.id); return s.json({ ok: true, declined: true });
  }
  const email = String(c.email || '').toLowerCase(); if (!email) throw bad('The candidate has no email address');
  if (await M.Employee.findOne({ where: { email } })) throw bad('An employee with this email already exists', 409);
  const temp = crypto.randomBytes(9).toString('base64url'), hourly = o.payType === 'hourly';
  const mgr: any = await M.Employee.findByPk(r.requestedBy, { attributes: ['id', 'role'] });
  const e: any = await M.Employee.create({ name: c.name, email, phone: c.phone, password: bcrypt.hashSync(temp, 12), mustChangePassword: true, role: 'employee', department: r.department, title: o.title, workState: r.workState, type: r.employmentType === 'part_time' ? 'part_time' : 'full_time',
    payType: o.payType, hourlyRate: hourly ? o.rate : 0, annualSalary: hourly ? 0 : o.rate, flsaExempt: o.flsaExempt, startDate: o.startDate, status: 'onboarding', managerId: mgr && ['manager', 'hr', 'admin'].includes(mgr.role) ? mgr.id : null,
    profile: { source: 'recruitment', candidateId: c.id }, failedAttempts: 0 } as any);
  for (const [t, h] of [['Annual', 80], ['Sick', sickHours(r.workState)]] as any) await M.LeaveBalance.create({ employeeId: e.id, type: t, total: h });
  await o.update({ status: 'accepted', respondedAt: new Date() }); await setStage(c, 'hired', q.user.id, 'Offer accepted', { employeeId: e.id, hiredAt: new Date() });
  const hired = (r.hired || 0) + 1; await r.update({ hired, status: hired >= r.headcount ? 'filled' : r.status });
  await startOnboarding(e, q.user.id); await queue(c, 'welcome', {}, q.user.id);
  await notify([r.requestedBy, ...(await hrIds())], 'recruitment', `Hired: ${c.name}`, `${o.title}, starts ${o.startDate}. ${hired >= r.headcount ? 'Requisition is now filled: review remaining candidates.' : ''}`, 'candidate', c.id); await log(q.user.id, 'Candidate Hired', `#${c.id} -> employee #${e.id}`);
  s.json({ ok: true, employeeId: e.id, tempPassword: temp });
}));

// ======================================================================
// Background check (S2): FCRA disclosure -> authorization -> report -> pre-adverse -> wait -> final
// ======================================================================
recruitmentRouter.post('/candidates/:id/background', hr, wrap(async (q, s) => {
  const { c } = await getCand(q.params.id, q.user); if (!['screening', 'interview', 'offer'].includes(c.stage)) throw bad('Background checks apply to active candidates only', 409);
  const action = String(q.body?.action || ''); let bg: any = await M.BackgroundCheck.findOne({ where: { candidateId: c.id } }); if (!bg) bg = await M.BackgroundCheck.create({ candidateId: c.id, status: 'none' } as any);
  const now = new Date(), t = R.bgTransition(bg.status, action, bg.preAdverseAt, now); if ('error' in t) throw bad(t.error, 409);
  const stamp: any = { send_disclosure: { disclosureAt: now, vendor: String(q.body?.vendor || '').trim().slice(0, 120) || null }, record_authorization: { authorizedAt: now }, record_report: { reportAt: now }, pre_adverse: { preAdverseAt: now }, final_adverse: { finalAt: now }, clear: { clearedAt: now } }[action];
  await bg.update({ status: t.to, ...stamp, note: String(q.body?.note || '').trim().slice(0, 500) || bg.note });
  const kind = ({ send_disclosure: 'background_disclosure', pre_adverse: 'pre_adverse', final_adverse: 'final_adverse' } as any)[action]; if (kind) await queue(c, kind, {}, q.user.id);
  if (action === 'final_adverse') { await M.Interview.update({ status: 'cancelled' }, { where: { candidateId: c.id, status: 'scheduled' } }); await M.Offer.update({ status: 'withdrawn' }, { where: { candidateId: c.id, status: { [Op.in]: ['pending_approval', 'approved', 'sent'] } } }); await setStage(c, 'rejected', q.user.id, R.REJECT_REASONS.background_result, { rejectReason: 'background_result', rejectedAt: new Date() }); }
  await log(q.user.id, 'Background Check', `#${c.id} ${action}`); s.json({ status: t.to });
}));

// ======================================================================
// Outbox (candidate communications) and summary
// ======================================================================
recruitmentRouter.get('/recruitment/messages', hr, wrap(async (q, s) => s.json(await M.CandidateMessage.findAll({ where: q.query.status === 'sent' ? { status: 'sent' } : { status: 'queued' }, order: [['id', 'DESC']], limit: 100 }))));
recruitmentRouter.post('/recruitment/messages/:id/sent', hr, wrap(async (q, s) => { const m: any = await M.CandidateMessage.findByPk(Number(q.params.id)); if (!m) throw bad('Not found', 404); await m.update({ status: 'sent', sentAt: new Date() }); s.json({ ok: true }); }));
/** Send a queued candidate message through SMTP. Without SMTP configured nothing is sent and the message stays queued (copy it out and use "Mark sent"). */
recruitmentRouter.post('/recruitment/messages/:id/send', hr, wrap(async (q, s) => {
  const m: any = await M.CandidateMessage.findByPk(Number(q.params.id)); if (!m) throw bad('Not found', 404);
  if (m.status === 'sent') throw bad('Already sent', 409);
  if (!mailConfigured()) throw bad('E-mail is not configured on the server (SMTP_HOST / SMTP_FROM). Copy the message and use "Mark sent".', 503);
  if (!m.toEmail) throw bad('This candidate has no email address');
  const st = await sendMail({ to: m.toEmail, subject: m.subject, text: m.body, kind: 'candidate:' + String(m.kind).slice(0, 25), companyId: m.companyId });
  if (st !== 'sent') throw bad('The mail server did not accept the message. It stays queued; try again or check the SMTP settings.', 502);
  await m.update({ status: 'sent', sentAt: new Date() }); await log(q.user.id, 'Candidate Email Sent', `#${m.candidateId} ${m.kind}`); s.json({ ok: true });
}));
recruitmentRouter.get('/recruitment/summary', staff, wrap(async (q, s) => {
  const mine = isHR(q.user) ? null : ((await M.Requisition.findAll({ where: { requestedBy: q.user.id }, attributes: ['id'], raw: true })) as any[]).map((x) => x.id);
  const rw: any = mine ? { id: { [Op.in]: mine.length ? mine : [0] } } : {}, cw: any = mine ? { requisitionId: { [Op.in]: mine.length ? mine : [0] } } : {};
  const cands: any[] = await M.Candidate.findAll({ where: cw, attributes: ['id', 'stage', 'source', 'createdAt', 'hiredAt'], raw: true });
  const byStage: Record<string, number> = {}; R.STAGES.forEach((x) => (byStage[x] = 0)); cands.forEach((x) => byStage[x.stage]++);
  const src = new Map<string, number>(); cands.forEach((x) => src.set(x.source || 'Direct', (src.get(x.source || 'Direct') || 0) + 1));
  const hired = cands.filter((x) => x.hiredAt), days = hired.length ? Math.round(hired.reduce((a, x) => a + (+new Date(x.hiredAt) - +new Date(x.createdAt)) / 864e5, 0) / hired.length) : null;
  const offers: any[] = await M.Offer.findAll({ where: mine ? { requisitionId: { [Op.in]: mine.length ? mine : [0] } } : {}, attributes: ['status'], raw: true }); const acc = offers.filter((o) => o.status === 'accepted').length, dec = offers.filter((o) => o.status === 'declined').length;
  const soon = await M.Interview.count({ where: { status: 'scheduled', scheduledAt: { [Op.between]: [new Date(), new Date(Date.now() + 7 * 864e5)] }, ...(mine ? { requisitionId: { [Op.in]: mine.length ? mine : [0] } } : {}) } as any });
  s.json({ openRequisitions: await M.Requisition.count({ where: { ...rw, status: 'open' } }), pendingApprovals: await M.Requisition.count({ where: { ...rw, status: 'pending_approval' } }), byStage, total: cands.length,
    sources: [...src].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count), avgDaysToHire: days, offersOut: offers.filter((o) => o.status === 'sent').length, offerAcceptRate: acc + dec ? Math.round((acc / (acc + dec)) * 100) : null,
    interviewsNext7Days: soon, queuedMessages: isHR(q.user) ? await M.CandidateMessage.count({ where: { status: 'queued' } }) : 0 });
}));
