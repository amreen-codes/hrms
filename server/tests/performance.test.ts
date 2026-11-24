import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const today = new Date().toISOString().slice(0, 10), plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let id: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n.toLowerCase()] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api/' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api/' + url).set(as(n));
const warn = (eid: number, extra: any = {}) => ({ employeeId: eid, issue: 'Missed 4 of 6 delivery deadlines in Q3 (dates attached)', standard: 'All deliveries on the agreed date', support: 'Weekly coaching and a reduced workload', timeline: 'Re-review in 30 days', consequences: 'Further steps up to termination may follow', policyVersion: '2026.1', reviewDeadline: plus(30), ...extra });

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const hana: any = await mk('Hana', 'hr'), hugo: any = await mk('Hugo', 'hr'), mia: any = await mk('Mia', 'manager'), olga: any = await mk('Olga', 'manager');
  const eli: any = await mk('Eli', 'employee', { managerId: mia.id }), tom: any = await mk('Tom', 'employee', { managerId: mia.id }), omar: any = await mk('Omar', 'employee', { managerId: olga.id });
  id = { hana: hana.id, hugo: hugo.id, mia: mia.id, olga: olga.id, eli: eli.id, tom: tom.id, omar: omar.id };
  for (const n of ['Hana', 'Hugo', 'Mia', 'Olga', 'Eli', 'Tom', 'Omar']) tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
});

describe('S5 goals and evaluations', () => {
  it('managers set measurable goals for their own team (versioned); the employee acknowledges', async () => {
    const goals = [{ title: 'On-time delivery', kpi: 'Deliveries on time', target: '95%', baseline: '70%' }];
    await post('olga', 'performance/goals', { employeeId: id.eli, goals, reviewDate: plus(90) }).expect(403);
    await post('mia', 'performance/goals', { employeeId: id.mia, goals, reviewDate: plus(90) }).expect(403);
    await post('mia', 'performance/goals', { employeeId: id.eli, goals: [{ title: 'x' }], reviewDate: plus(90) }).expect(400); await post('mia', 'performance/goals', { employeeId: id.eli, goals, reviewDate: plus(-1) }).expect(400);
    const g = (await post('mia', 'performance/goals', { employeeId: id.eli, goals, reviewDate: plus(90) }).expect(201)).body; expect(g.version).toBe(1);
    expect((await post('mia', 'performance/goals', { employeeId: id.eli, goals, reviewDate: plus(120) }).expect(201)).body.version).toBe(2);
    await post('omar', `performance/goals/${g.id}/ack`).expect(404); await post('eli', `performance/goals/${g.id}/ack`).expect(200); await post('eli', `performance/goals/${g.id}/ack`).expect(404);
    expect((await get('eli', 'performance/goals').expect(200)).body.every((x: any) => x.employeeId === id.eli)).toBe(true); expect((await get('omar', 'performance/goals').expect(200)).body.length).toBe(0);
  });
  it('evaluations need facts and evidence, stay hidden as drafts, and acknowledgement is not agreement', async () => {
    const ev = { employeeId: id.eli, periodStart: plus(-90), periodEnd: today, kind: 'scheduled', score: 3, strengths: 'Collaborates well with the team', gaps: 'Missed several delivery dates', expectations: 'Deliver on the agreed date', improvementNeeded: true, conductNote: 'Separate: no conduct issues', evidence: [{ source: 'Project tracker', date: plus(-20), note: 'Release slipped 5 days' }] };
    await post('mia', 'performance/evaluations', { ...ev, score: 9 }).expect(400); await post('mia', 'performance/evaluations', { ...ev, gaps: 'short' }).expect(400); await post('mia', 'performance/evaluations', { ...ev, evidence: [] }).expect(400);
    await post('olga', 'performance/evaluations', ev).expect(403);
    const e = (await post('mia', 'performance/evaluations', ev).expect(201)).body;
    expect((await get('eli', 'performance/evaluations').expect(200)).body.length).toBe(0);                                  // draft: not visible
    await post('tom', `performance/evaluations/${e.id}/deliver`).expect(403); await post('mia', `performance/evaluations/${e.id}/deliver`).expect(200); await post('mia', `performance/evaluations/${e.id}/deliver`).expect(409);
    const mine = (await get('eli', 'performance/evaluations').expect(200)).body; expect(mine.length).toBe(1); expect(mine[0].conductNote).toBeUndefined();
    await post('omar', `performance/evaluations/${e.id}/ack`, {}).expect(404);
    await post('eli', `performance/evaluations/${e.id}/ack`, { response: 'I disagree with the second point' }).expect(200); await post('eli', `performance/evaluations/${e.id}/ack`, {}).expect(404);
    expect(((await M.Evaluation.findByPk(e.id)) as any).employeeResponse).toMatch(/disagree/);
  });
});

describe('S5 progressive warnings, PIP and the path to termination review', () => {
  let w1: number, w2: number, w3: number, pip: number;
  it('first written warning: all five fields, by the manager or HR, issued directly', async () => {
    await post('olga', 'performance/warnings', warn(id.eli)).expect(403); await post('mia', 'performance/warnings', warn(id.mia)).expect(403);
    await post('mia', 'performance/warnings', { ...warn(id.eli), consequences: '', support: '' }).expect(400).then((r) => expect(r.body.error).toMatch(/consequences is required.*support is required|support is required.*consequences is required/));
    await post('mia', 'performance/warnings', { ...warn(id.eli), reviewDeadline: plus(-1) }).expect(400); await post('mia', 'performance/warnings', { ...warn(id.eli), policyVersion: '' }).expect(400);
    const w = (await post('mia', 'performance/warnings', warn(id.eli)).expect(201)).body; w1 = w.id; expect([w.level, w.status]).toEqual(['first_written', 'issued']);
    expect(await M.Notification.count({ where: { userId: id.eli, title: 'You have received a written warning' } })).toBe(1);
  });
  it('the employee acknowledges (not agreement) or refuses with a named witness', async () => {
    await post('omar', `performance/warnings/${w1}/ack`, { outcome: 'acknowledged' }).expect(404);
    await post('eli', `performance/warnings/${w1}/ack`, { outcome: 'maybe' }).expect(400); await post('eli', `performance/warnings/${w1}/ack`, { outcome: 'refused' }).expect(400);
    await post('eli', `performance/warnings/${w1}/ack`, { outcome: 'acknowledged', response: 'I received it but disagree' }).expect(200); await post('eli', `performance/warnings/${w1}/ack`, { outcome: 'acknowledged' }).expect(404);
  });
  it('second warning needs a consistency review; a manager proposes and HR (not the author) approves', async () => {
    await post('mia', 'performance/warnings', warn(id.eli)).expect(400);                                                      // consistency review missing
    const w = (await post('mia', 'performance/warnings', warn(id.eli, { consistencyNote: 'Same standard applied to the team; no mitigating facts found' })).expect(201)).body; w2 = w.id; expect([w.level, w.status]).toEqual(['second', 'pending_approval']);
    expect((await get('eli', 'performance/warnings').expect(200)).body.map((x: any) => x.level)).toEqual(['first_written']);   // pending is not visible to the employee
    await post('mia', 'performance/warnings', warn(id.eli, { consistencyNote: 'twice at once should be blocked' })).expect(409);
    await post('mia', `performance/warnings/${w2}/approve`, { approve: true }).expect(403); await post('hana', `performance/warnings/${w2}/approve`, { approve: false }).expect(400);
    await post('hana', `performance/warnings/${w2}/approve`, { approve: true }).expect(200); await post('hana', `performance/warnings/${w2}/approve`, { approve: true }).expect(409);
    expect((await get('eli', 'performance/warnings').expect(200)).body.length).toBe(2);
  });
  it('HR may issue the final warning directly; nothing beyond final; HR can withdraw with a reason', async () => {
    const w = (await post('hana', 'performance/warnings', warn(id.eli, { consistencyNote: 'Reviewed comparable cases: consistent treatment' })).expect(201)).body; w3 = w.id; expect([w.level, w.status]).toEqual(['final', 'issued']);
    await post('hana', 'performance/warnings', warn(id.eli, { consistencyNote: 'a fourth warning is not allowed' })).expect(409);
    const tomW = (await post('mia', 'performance/warnings', warn(id.tom)).expect(201)).body.id;
    await post('mia', `performance/warnings/${tomW}/withdraw`, { note: 'withdrawing this warning now' }).expect(403); await post('hana', `performance/warnings/${tomW}/withdraw`, { note: 'short' }).expect(400);
    await post('hana', `performance/warnings/${tomW}/withdraw`, { note: 'Issued in error: wrong employee file' }).expect(200);
    expect((await post('mia', 'performance/warnings', warn(id.tom)).expect(201)).body.level).toBe('first_written');           // a withdrawn warning does not count on the ladder
  });
  it('improvement plan: bounded, one active, check-ins record objective progress and support', async () => {
    const body = { employeeId: id.eli, warningId: w1, startDate: today, endDate: plus(60), goals: [{ title: 'Deliver on time', target: '95%' }], support: 'Weekly coaching and a mentor' };
    await post('olga', 'performance/pips', body).expect(403); await post('mia', 'performance/pips', { ...body, endDate: plus(3) }).expect(400); await post('mia', 'performance/pips', { ...body, endDate: plus(400) }).expect(400);
    await post('mia', 'performance/pips', { ...body, warningId: 99999 }).expect(404 === 404 ? 400 : 400); await post('mia', 'performance/pips', { ...body, support: 'x' }).expect(400);
    pip = (await post('mia', 'performance/pips', body).expect(201)).body.id; await post('mia', 'performance/pips', body).expect(409);
    await post('mia', `performance/pips/${pip}/checkin`, { progress: 'ok', support: 'coaching' }).expect(400);
    await post('mia', `performance/pips/${pip}/checkin`, { progress: 'Two of four deliveries on time this fortnight', support: 'Held 2 coaching sessions' }).expect(200);
    await post('olga', `performance/pips/${pip}/checkin`, { progress: 'Two of four deliveries on time', support: 'x' }).expect(403);
    expect((await get('eli', 'performance/pips').expect(200)).body[0].hrLegalNote).toBeUndefined();
  });
  it('outcomes: HR only, rationale required, extensions capped at two', async () => {
    await post('mia', `performance/pips/${pip}/outcome`, { outcome: 'success', note: 'Goals met this period' }).expect(403);
    await post('hana', `performance/pips/${pip}/outcome`, { outcome: 'maybe', note: 'Goals met this period' }).expect(400); await post('hana', `performance/pips/${pip}/outcome`, { outcome: 'success', note: 'short' }).expect(400);
    await post('hana', `performance/pips/${pip}/outcome`, { outcome: 'extended', note: 'Progress is partial, extend', newEndDate: plus(10) }).expect(400);   // not after the current end date
    await post('hana', `performance/pips/${pip}/outcome`, { outcome: 'extended', note: 'Progress is partial, extend 30 days', newEndDate: plus(90) }).expect(200);
    await post('hana', `performance/pips/${pip}/outcome`, { outcome: 'extended', note: 'Second extension for coaching', newEndDate: plus(120) }).expect(200);
    await post('hana', `performance/pips/${pip}/outcome`, { outcome: 'extended', note: 'A third extension is refused', newEndDate: plus(150) }).expect(409);
  });
  it('termination can only be considered after the final warning, final review and HR/legal review, and it only PROPOSES a separation for another HR user', async () => {
    const t = { outcome: 'termination_review', note: 'Targets not met after support and extensions', finalReviewDone: true, hrLegalReviewed: true, hrLegalNote: 'Checked leave, accommodation, retaliation risk and consistency' };
    await post('hana', `performance/pips/${pip}/outcome`, { ...t, finalReviewDone: false }).expect(409); await post('hana', `performance/pips/${pip}/outcome`, { ...t, hrLegalReviewed: false }).expect(409);
    await post('hana', `performance/pips/${pip}/outcome`, { ...t, hrLegalNote: 'short' }).expect(400);
    const r = (await post('hana', `performance/pips/${pip}/outcome`, t).expect(200)).body; expect(r.status).toBe('closed_termination_review');
    const off: any = await M.Offboarding.findOne({ where: { employeeId: id.eli } }); expect([off.status, off.reason, off.proposedBy]).toEqual(['proposed', 'performance', id.hana]);
    expect((await M.Employee.findByPk(id.eli) as any).status).toBe('active');                                                   // nothing happens until HR approves
    await post('hana', `offboarding/${off.id}/decide`, { approve: true }).expect(403);                                          // the proposer cannot approve (S6)
    await post('hugo', `offboarding/${off.id}/decide`, { approve: true }).expect(200);
  });
  it('a plan without a final warning cannot lead to a termination review', async () => {
    const wTom: any = await M.Warning.findOne({ where: { employeeId: id.tom, status: 'issued' } }); expect(wTom.level).toBe('first_written');
    const p = (await post('mia', 'performance/pips', { employeeId: id.tom, startDate: today, endDate: plus(60), goals: [{ title: 'Quality', target: '< 2 defects' }], support: 'Pairing with a senior colleague' }).expect(201)).body.id;
    await post('hana', `performance/pips/${p}/outcome`, { outcome: 'termination_review', note: 'Wants to terminate quickly', finalReviewDone: true, hrLegalReviewed: true, hrLegalNote: 'Reviewed everything thoroughly' }).expect(409);
    await post('hana', `performance/pips/${p}/outcome`, { outcome: 'success', note: 'Quality targets met in full' }).expect(200);
    expect(await M.AuditLog.count({ where: { action: 'PIP Termination Review' } })).toBe(1);
  });
});
