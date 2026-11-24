import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
let ids: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api' + url).set(as(n));
const future = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const REQ = { title: 'Support Engineer', department: 'Support', workState: 'TX', city: 'Austin', headcount: 1, payType: 'salary', payMin: 60000, payMax: 90000, justification: 'Ticket volume doubled this quarter.', description: 'Help customers solve technical problems and escalate bugs.', minQuals: ['2 years support experience', 'Strong written English'], questions: ['Describe a hard customer issue you solved.'] };
const APPLY = (n: string, extra: any = {}) => ({ name: n, email: `${n.toLowerCase().replace(/\W/g, '')}@mail.test`, phone: '+1 512 555 0100', resumeRef: 'https://example.com/cv.pdf', workAuthorized: true, needsSponsorship: false, consent: true, history: [{ employer: 'Acme Corp', title: 'Agent' }], answers: { 0: 'I fixed a recurring sync bug.' }, ...extra });
let reqId = 0, candId = 0, interviewId = 0, offerId = 0;

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const hr: any = await mk('Hana', 'hr'), mgr: any = await mk('Mia', 'manager'), eli: any = await mk('Eli', 'employee'), omar: any = await mk('Omar', 'employee'), hr2: any = await mk('Hugo', 'hr');
  ids = { hr: hr.id, mgr: mgr.id, eli: eli.id, omar: omar.id, hr2: hr2.id };
  for (const n of ['Hana', 'Mia', 'Eli', 'Omar', 'Hugo']) tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
});

describe('requisitions (S1)', () => {
  it('blocks prohibited screening questions at creation', async () => {
    const r = await post('mia', '/requisitions', { ...REQ, questions: ['Are you married?'] }); expect(r.status).toBe(400); expect(r.body.error).toMatch(/not allowed/i);
  });
  it('employees cannot create requisitions; a manager can, and it starts as a draft', async () => {
    await post('omar', '/requisitions', REQ).expect(403);
    const r = await post('mia', '/requisitions', REQ).expect(201); reqId = r.body.id; expect(r.body.status).toBe('draft');
  });
  it('workflow: submit -> HR approves (not the requester) -> publish', async () => {
    await post('hana', `/requisitions/${reqId}/publish`, { channels: ['Careers page'] }).expect(409);       // not approved yet
    await post('mia', `/requisitions/${reqId}/submit`).expect(200);
    await post('mia', `/requisitions/${reqId}/decision`, { approve: true }).expect(403);                    // managers cannot approve
    await post('hana', `/requisitions/${reqId}/decision`, { approve: true }).expect(200);
    await post('hana', `/requisitions/${reqId}/publish`, { channels: [] }).expect(400);
    await post('hana', `/requisitions/${reqId}/publish`, { channels: ['Careers page', 'Job boards'] }).expect(200);
  });
  it('HR cannot approve their own requisition', async () => {
    const r = await post('hana', '/requisitions', REQ).expect(201); await post('hana', `/requisitions/${r.body.id}/submit`).expect(200);
    await post('hana', `/requisitions/${r.body.id}/decision`, { approve: true }).expect(403); await post('hugo', `/requisitions/${r.body.id}/decision`, { approve: true }).expect(200);
  });
  it('pay range is mandatory to publish in a pay transparency state (CA)', async () => {
    const r = await post('mia', '/requisitions', { ...REQ, workState: 'CA', payMin: '', payMax: '' }).expect(201);
    await post('mia', `/requisitions/${r.body.id}/submit`); await post('hana', `/requisitions/${r.body.id}/decision`, { approve: true });
    const p = await post('hana', `/requisitions/${r.body.id}/publish`, { channels: ['Careers page'] }); expect(p.status).toBe(400); expect(p.body.error).toMatch(/pay range/i);
  });
  it('a manager only sees their own requisitions', async () => {
    const mine = (await get('mia', '/requisitions').expect(200)).body, all = (await get('hana', '/requisitions').expect(200)).body;
    expect(mine.every((x: any) => x.requestedBy === ids.mgr)).toBe(true); expect(all.length).toBeGreaterThan(mine.length);
  });
});

describe('careers page and intake (S1)', () => {
  it('lists only open jobs, publicly, without leaking internals', async () => {
    const r = await request(app).get('/api/public/test/jobs').expect(200); expect(r.body.length).toBe(1); expect(r.body[0].title).toBe('Support Engineer');
    expect(JSON.stringify(r.body)).not.toMatch(/justification|requestedBy|channels/);
  });
  it('validates the application and requires consent and both work authorization answers', async () => {
    await request(app).post(`/api/public/test/jobs/${reqId}/apply`).send(APPLY('Hina Tariq', { consent: false })).expect(400);
    await request(app).post(`/api/public/test/jobs/${reqId}/apply`).send(APPLY('Hina Tariq', { email: 'nope' })).expect(400);
    await request(app).post(`/api/public/test/jobs/${reqId}/apply`).send(APPLY('Hina Tariq', { workAuthorized: undefined })).expect(400);
    await request(app).post(`/api/public/test/jobs/${reqId}/apply`).send(APPLY('Hina Tariq', { answers: {} })).expect(400);       // every job question must be answered
  });
  it('accepts a valid application, queues the acknowledgement, rejects a duplicate, ignores bots', async () => {
    await request(app).post(`/api/public/test/jobs/${reqId}/apply`).send(APPLY('Hina Tariq')).expect(200);
    const dup = await request(app).post(`/api/public/test/jobs/${reqId}/apply`).send(APPLY('Hina Tariq')); expect(dup.status).toBe(409);
    await request(app).post(`/api/public/test/jobs/${reqId}/apply`).send(APPLY('Bot Man', { website: 'http://spam' })).expect(200); expect(await M.Candidate.count({ where: { name: 'Bot Man' } })).toBe(0);
    const c: any = await M.Candidate.findOne({ where: { name: 'Hina Tariq' } }); candId = c.id; expect(c.stage).toBe('received'); expect(c.consentAt).toBeTruthy();
    expect(await M.CandidateMessage.count({ where: { candidateId: candId, kind: 'application_received', status: 'queued' } })).toBe(1);
    await request(app).post('/api/public/test/jobs/999999/apply').send(APPLY('Ghost One')).expect(404);
  });
  it('candidate data is not public and not visible to employees', async () => {
    await request(app).get('/api/candidates').expect(401); await get('omar', '/candidates').expect(403); await get('omar', `/candidates/${candId}`).expect(403);
    expect((await get('mia', '/candidates').expect(200)).body.length).toBe(1);        // the requisition owner sees it
  });
});

describe('screening and stage rules (S2)', () => {
  it('cannot skip stages or move without a screening', async () => {
    await post('hana', `/candidates/${candId}/move`, { to: 'offer' }).expect(409); await post('hana', `/candidates/${candId}/move`, { to: 'hired' }).expect(400);
  });
  it('rubric needs every rating and a rationale; stores a weighted score; auto-moves to Screening', async () => {
    await post('hana', `/candidates/${candId}/screen`, { ratings: { skills: 5 }, rationale: 'good fit overall' }).expect(400);
    await post('hana', `/candidates/${candId}/screen`, { ratings: { skills: 4, experience: 4, credentials: 4, availability: 4 }, checks: [true, false], rationale: 'short' }).expect(400);
    const r = await post('hana', `/candidates/${candId}/screen`, { ratings: { skills: 4, experience: 4, credentials: 4, availability: 4 }, checks: [true, false], rationale: 'Strong written answers but one year of experience only.' }).expect(200);
    expect(r.body.score).toBe(75); expect(r.body.meetsAll).toBe(false); expect(((await M.Candidate.findByPk(candId)) as any).stage).toBe('screening');
    const m = await post('hana', `/candidates/${candId}/move`, { to: 'interview' }); expect(m.status).toBe(409); expect(m.body.error).toMatch(/minimum qualifications/i);
  });
  it('does not allow rejecting on an unexplained work-history discrepancy', async () => {
    await post('hana', `/candidates/${candId}/history/0`, { status: 'discrepancy', note: 'Dates do not match the reference' }).expect(200);
    await post('hana', `/candidates/${candId}/move`, { to: 'rejected', reason: 'verification_discrepancy' }).expect(409);
    await post('hana', `/candidates/${candId}/history/0`, { status: 'discrepancy', clarification: 'Company was renamed in 2021' }).expect(200);
    await post('hana', `/candidates/${candId}/history/0`, { status: 'verified' }).expect(200);
  });
  it('rejection needs a valid reason; qualified candidate advances to Interview', async () => {
    await post('hana', `/candidates/${candId}/move`, { to: 'rejected' }).expect(400);
    await post('hana', `/candidates/${candId}/screen`, { ratings: { skills: 5, experience: 4, credentials: 4, availability: 5 }, checks: [true, true], rationale: 'Verified experience after clarification.' }).expect(200);
    await post('hana', `/candidates/${candId}/move`, { to: 'interview' }).expect(200);
    const tl = (await get('hana', `/candidates/${candId}`)).body.timeline.map((x: any) => x.toStage); expect(tl).toEqual(['received', 'screening', 'interview']);
  });
});

describe('interviews and blind scorecards (S3)', () => {
  it('schedules with a panel, queues the invitation and notifies the panel', async () => {
    await post('hana', `/candidates/${candId}/interviews`, { scheduledAt: new Date(Date.now() - 864e5).toISOString(), panel: [ids.eli] }).expect(400);
    await post('hana', `/candidates/${candId}/interviews`, { scheduledAt: new Date(Date.now() + 2 * 864e5).toISOString(), panel: [] }).expect(400);
    const r = await post('hana', `/candidates/${candId}/interviews`, { scheduledAt: new Date(Date.now() + 2 * 864e5).toISOString(), panel: [ids.eli, ids.mgr], format: 'video', location: 'https://meet.test/abc', tz: 'CT' }).expect(201); interviewId = r.body.id;
    const inv: any = await M.CandidateMessage.findOne({ where: { candidateId: candId, kind: 'interview_invite' } }); expect(inv.body).toContain('Eli'); expect(inv.body).toMatch(/accommodation/i);
    expect(await M.Notification.count({ where: { userId: ids.eli, type: 'recruitment' } })).toBeGreaterThan(0);
    expect((await get('eli', '/my/interviews').expect(200)).body.interviews.length).toBe(1); expect((await get('omar', '/my/interviews').expect(200)).body.interviews.length).toBe(0);
  });
  it('an offer needs at least one scorecard', async () => {
    const r = await post('mia', `/candidates/${candId}/move`, { to: 'offer' }); expect(r.status).toBe(409); expect(r.body.error).toMatch(/scorecard/i);
  });
  const card = (rec: string, n = 4) => ({ scores: { role: n, problem: n, communication: n, teamwork: n, motivation: n }, recommendation: rec, notes: 'Clear structured answers with concrete examples.' });
  it('only panel members can score; one scorecard each; ratings validated', async () => {
    await post('omar', `/interviews/${interviewId}/scorecard`, card('yes')).expect(403);
    await post('eli', `/interviews/${interviewId}/scorecard`, { ...card('yes'), scores: { role: 9 } }).expect(400);
    await post('eli', `/interviews/${interviewId}/scorecard`, card('yes', 5)).expect(201); await post('eli', `/interviews/${interviewId}/scorecard`, card('yes')).expect(409);
  });
  it('scores are blind: a panelist who has not scored cannot see colleagues\u2019 scorecards, until they submit', async () => {
    let d = (await get('mia', `/candidates/${candId}`).expect(200)).body; expect(d.interviews[0].cardsHidden).toBe(true); expect(d.interviews[0].scorecards.length).toBe(0);
    d = (await get('hana', `/candidates/${candId}`).expect(200)).body; expect(d.interviews[0].cardsHidden).toBe(false); expect(d.interviews[0].scorecards.length).toBe(1);   // HR is not on the panel
    await post('mia', `/interviews/${interviewId}/scorecard`, card('strong_yes')).expect(201);
    d = (await get('mia', `/candidates/${candId}`).expect(200)).body; expect(d.interviews[0].scorecards.length).toBe(2); expect(d.interviews[0].status).toBe('completed'); expect(d.panel.count).toBe(2);
  });
});

describe('offer, approval and hire (S3, P6 -> P5)', () => {
  it('the hiring manager approves the candidate (moves to Offer); HR cannot be bypassed on offer terms', async () => {
    await post('omar', `/candidates/${candId}/move`, { to: 'offer' }).expect(403); await post('mia', `/candidates/${candId}/move`, { to: 'offer' }).expect(200);
  });
  it('validates the offer: dates, posted pay range, one open offer at a time', async () => {
    const base = { payType: 'salary', rate: 75000, startDate: future(20), deadline: future(7), contingencies: 'Satisfactory reference check' };
    await post('hana', `/candidates/${candId}/offer`, { ...base, rate: 200000 }).expect(400); await post('hana', `/candidates/${candId}/offer`, { ...base, deadline: future(30) }).expect(400);
    await post('hana', `/candidates/${candId}/offer`, { ...base, startDate: '2020-01-01' }).expect(400);
    const o = await post('hana', `/candidates/${candId}/offer`, base).expect(201); offerId = o.body.id; await post('hana', `/candidates/${candId}/offer`, base).expect(409);
  });
  it('maker-checker: the creator cannot approve; unapproved offers cannot be sent', async () => {
    await post('hana', `/offers/${offerId}/send`).expect(409); await post('hana', `/offers/${offerId}/approve`, { approve: true }).expect(403); await post('omar', `/offers/${offerId}/approve`, { approve: true }).expect(403);
    await post('mia', `/offers/${offerId}/approve`, { approve: true }).expect(200);
  });
  it('sends the offer letter, then acceptance creates the employee with onboarding and fills the requisition', async () => {
    await post('hana', `/offers/${offerId}/respond`, { accepted: true }).expect(409);       // not sent yet
    await post('hana', `/offers/${offerId}/send`).expect(200);
    const letter: any = await M.CandidateMessage.findOne({ where: { candidateId: candId, kind: 'offer' } }); expect(letter.body).toContain('$75,000 per year'); expect(letter.body).toContain('Satisfactory reference check');
    const r = await post('hana', `/offers/${offerId}/respond`, { accepted: true }).expect(200); expect(r.body.tempPassword).toBeTruthy();
    const e: any = await M.Employee.findByPk(r.body.employeeId); expect(e.status).toBe('onboarding'); expect(e.managerId).toBe(ids.mgr); expect(Number(e.annualSalary)).toBe(75000); expect(e.workState).toBe('TX');
    expect(await M.LifecycleTask.count({ where: { employeeId: e.id, kind: 'onboarding' } })).toBeGreaterThan(5); expect(await M.LeaveBalance.count({ where: { employeeId: e.id } })).toBe(2);
    expect(((await M.Candidate.findByPk(candId)) as any).stage).toBe('hired'); expect(((await M.Requisition.findByPk(reqId)) as any).status).toBe('filled');
    await post('hana', `/offers/${offerId}/respond`, { accepted: true }).expect(409);       // cannot hire twice
    expect((await request(app).get('/api/public/test/jobs')).body.length).toBe(0);               // filled job leaves the careers page
  });
});

describe('FCRA background check and adverse action (S2)', () => {
  let rid = 0, cid = 0;
  beforeAll(async () => {
    const r = await post('mia', '/requisitions', { ...REQ, title: 'Analyst', headcount: 2 }).expect(201); rid = r.body.id; await post('mia', `/requisitions/${rid}/submit`); await post('hana', `/requisitions/${rid}/decision`, { approve: true }); await post('hana', `/requisitions/${rid}/publish`, { channels: ['Careers page'] }).expect(200);
    await request(app).post(`/api/public/test/jobs/${rid}/apply`).send(APPLY('Bilal Sheikh')).expect(200); cid = ((await M.Candidate.findOne({ where: { name: 'Bilal Sheikh' } })) as any).id;
    await post('hana', `/candidates/${cid}/screen`, { ratings: { skills: 3, experience: 3, credentials: 3, availability: 3 }, checks: [true, true], rationale: 'Meets every minimum qualification.' }).expect(200);
  });
  it('steps must follow the order; the final notice needs the waiting period', async () => {
    await post('hana', `/candidates/${cid}/background`, { action: 'record_report' }).expect(409);
    for (const a of ['send_disclosure', 'record_authorization', 'record_report', 'pre_adverse']) await post('hana', `/candidates/${cid}/background`, { action: a }).expect(200);
    expect(await M.CandidateMessage.count({ where: { candidateId: cid, kind: 'pre_adverse' } })).toBe(1);
    const early = await post('hana', `/candidates/${cid}/background`, { action: 'final_adverse' }); expect(early.status).toBe(409); expect(early.body.error).toMatch(/waiting period/i);
    await post('hana', `/candidates/${cid}/move`, { to: 'rejected', reason: 'background_result' }).expect(409);
  });
  it('after the waiting period the final notice is sent and the candidate is rejected with the right reason', async () => {
    await M.BackgroundCheck.update({ preAdverseAt: new Date(Date.now() - 14 * 864e5) } as any, { where: { candidateId: cid } });
    await post('hana', `/candidates/${cid}/background`, { action: 'final_adverse' }).expect(200);
    const c: any = await M.Candidate.findByPk(cid); expect(c.stage).toBe('rejected'); expect(c.rejectReason).toBe('background_result'); expect(await M.CandidateMessage.count({ where: { candidateId: cid, kind: 'final_adverse' } })).toBe(1);
  });
  it('only HR can run background checks', async () => { await post('mia', `/candidates/${cid}/background`, { action: 'send_disclosure' }).expect(403); });
});

describe('outbox and summary', () => {
  it('HR sees queued messages and can mark them sent; managers cannot', async () => {
    const q = (await get('hana', '/recruitment/messages').expect(200)).body; expect(q.length).toBeGreaterThan(3); await get('mia', '/recruitment/messages').expect(403);
    await post('hana', `/recruitment/messages/${q[0].id}/sent`).expect(200); expect((await get('hana', '/recruitment/messages').expect(200)).body.length).toBe(q.length - 1);
  });
  it('summary has funnel, sources and accept rate, scoped for managers', async () => {
    const s = (await get('hana', '/recruitment/summary').expect(200)).body; expect(s.byStage.hired).toBe(1); expect(s.total).toBe(2); expect(s.offerAcceptRate).toBe(100); expect(s.sources[0].source).toBe('Careers page'); expect(s.queuedMessages).toBeGreaterThan(0);
    const m = (await get('mia', '/recruitment/summary').expect(200)).body; expect(m.queuedMessages).toBe(0); await get('omar', '/recruitment/summary').expect(403);
  });
});
