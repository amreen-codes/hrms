import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { runTrainingJob } from '../src/training';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const today = new Date().toISOString().slice(0, 10), plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let id: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n.toLowerCase()] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api/' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api/' + url).set(as(n));

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const hana: any = await mk('Hana', 'hr'), mia: any = await mk('Mia', 'manager'), olga: any = await mk('Olga', 'manager');
  const eli: any = await mk('Eli', 'employee', { managerId: mia.id }), tom: any = await mk('Tom', 'employee', { managerId: mia.id }), omar: any = await mk('Omar', 'employee', { managerId: olga.id });
  id = { hana: hana.id, mia: mia.id, olga: olga.id, eli: eli.id, tom: tom.id, omar: omar.id };
  for (const n of ['Hana', 'Mia', 'Olga', 'Eli', 'Tom', 'Omar']) tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
});

describe('S4 courses and assignments', () => {
  let safety: number, advanced: number, record: number;
  it('HR builds a validated course catalogue; employees only see active courses', async () => {
    const c = { title: 'Workplace Safety', category: 'safety', deliveryMethod: 'online', version: '2026.1', passScore: 80, recurrenceMonths: 12 };
    await post('mia', 'courses', c).expect(403);
    await post('hana', 'courses', { ...c, title: '' }).expect(400); await post('hana', 'courses', { ...c, category: 'fun' }).expect(400); await post('hana', 'courses', { ...c, passScore: 150 }).expect(400); await post('hana', 'courses', { ...c, recurrenceMonths: 0 }).expect(400);
    safety = (await post('hana', 'courses', c).expect(201)).body.id;
    advanced = (await post('hana', 'courses', { title: 'Advanced Safety', category: 'safety', deliveryMethod: 'in_person', version: '1', prerequisiteId: safety }).expect(201)).body.id;
    record = (await post('hana', 'courses', { title: 'Forklift Practical', category: 'role', deliveryMethod: 'in_person', version: '1', passScore: 70 }).expect(201)).body.id;
    await post('hana', 'courses', { title: 'Retired', category: 'other', deliveryMethod: 'self_study', version: '1', prerequisiteId: 99999 }).expect(404);
    const old = (await post('hana', 'courses', { title: 'Old', category: 'other', deliveryMethod: 'self_study', version: '1' }).expect(201)).body.id; await request(app).patch(`/api/courses/${old}`).set(as('hana')).send({ active: false }).expect(200);
    expect((await get('eli', 'courses').expect(200)).body.map((x: any) => x.title)).not.toContain('Old'); expect((await get('hana', 'courses').expect(200)).body.length).toBe(4);
  });
  it('assigns by role: HR anyone, a manager only their team, never yourself; skips duplicates', async () => {
    await post('eli', 'training/assign', { courseId: safety, employeeIds: [id.eli], dueDate: plus(30) }).expect(403);
    await post('mia', 'training/assign', { courseId: safety, employeeIds: [id.eli], dueDate: plus(-1) }).expect(400);
    const r = (await post('mia', 'training/assign', { courseId: safety, employeeIds: [id.eli, id.omar, id.mia], dueDate: plus(30) }).expect(201)).body;
    expect(r.assigned).toBe(1); expect(r.skipped.join()).toMatch(/Omar: not on your team/); expect(r.skipped.join()).toMatch(/yourself/);
    expect((await post('mia', 'training/assign', { courseId: safety, employeeIds: [id.eli], dueDate: plus(30) }).expect(201)).body.skipped.join()).toMatch(/already assigned/);
    expect((await post('hana', 'training/assign', { courseId: safety, employeeIds: [id.omar, id.tom], dueDate: plus(30) }).expect(201)).body.assigned).toBe(2);
    expect((await get('eli', 'training').expect(200)).body.every((a: any) => a.employeeId === id.eli)).toBe(true);
    expect((await get('mia', 'training').expect(200)).body.some((a: any) => a.employeeId === id.omar)).toBe(false);
  });
  it('the pass mark, attempts, acknowledgement and certificate evidence are enforced; recurrence creates the next assignment', async () => {
    const a: any = await M.CourseAssignment.findOne({ where: { courseId: safety, employeeId: id.eli } });
    await post('omar', `training/${a.id}/complete`, { acknowledged: true, score: 90 }).expect(404);                           // not their assignment
    await post('eli', `training/${a.id}/complete`, { score: 90 }).expect(400);                                               // acknowledgement required
    await post('eli', `training/${a.id}/complete`, { acknowledged: true }).expect(400);                                       // score required for a pass mark
    const fail = (await post('eli', `training/${a.id}/complete`, { acknowledged: true, score: 50 }).expect(200)).body; expect([fail.passed, fail.attempts]).toEqual([false, 1]);
    expect(((await M.CourseAssignment.findByPk(a.id)) as any).completedAt).toBeNull();
    expect((await post('eli', `training/${a.id}/complete`, { acknowledged: true, score: 85, certificateRef: 'cert-001' }).expect(200)).body.passed).toBe(true);
    const done: any = await M.CourseAssignment.findByPk(a.id); expect([done.score, done.attempts, done.certificateRef]).toEqual([85, 2, 'cert-001']);
    await post('eli', `training/${a.id}/complete`, { acknowledged: true, score: 85 }).expect(409);
    const next: any = await M.CourseAssignment.findOne({ where: { recurredFromId: a.id } }); expect(next).toBeTruthy(); expect(next.dueDate > plus(300)).toBe(true);   // annual refresher
    expect(await M.Notification.count({ where: { userId: id.mia, title: 'Training completed' } })).toBe(1);
  });
  it('prerequisites must be completed first', async () => {
    await post('hana', 'training/assign', { courseId: advanced, employeeIds: [id.tom], dueDate: plus(30) }).expect(201);
    const a: any = await M.CourseAssignment.findOne({ where: { courseId: advanced, employeeId: id.tom } });
    expect((await post('tom', `training/${a.id}/start`).expect(409)).body.error).toMatch(/prerequisite first: Workplace Safety/);
    await post('tom', `training/${a.id}/complete`, { acknowledged: true }).expect(409);
  });
  it('HR records in-person completion with a verification note; never your own; needs a passing score', async () => {
    await post('hana', 'training/assign', { courseId: record, employeeIds: [id.eli, id.hana], dueDate: plus(30) }).expect(201);
    const a: any = await M.CourseAssignment.findOne({ where: { courseId: record, employeeId: id.eli } });
    await post('mia', `training/${a.id}/record`, { completedOn: today, note: 'sign-in sheet' }).expect(403);
    await post('hana', `training/${a.id}/record`, { completedOn: plus(3), note: 'sign-in sheet' }).expect(400); await post('hana', `training/${a.id}/record`, { completedOn: today, note: 'x' }).expect(400);
    await post('hana', `training/${a.id}/record`, { completedOn: today, note: 'sign-in sheet', score: 40 }).expect(400);
    await post('hana', `training/${a.id}/record`, { completedOn: today, note: 'Signed attendance sheet 14 Nov', score: 90 }).expect(200);
    const own: any = await M.CourseAssignment.create({ courseId: record, employeeId: id.hana, courseVersion: '1', dueDate: plus(30) } as any); await post('hana', `training/${own.id}/record`, { completedOn: today, note: 'my own', score: 90 }).expect(403);
  });
  it('status and the compliance dashboard follow due dates; the daily job reminds and escalates once', async () => {
    const tomA: any = await M.CourseAssignment.findOne({ where: { courseId: safety, employeeId: id.tom } });
    await tomA.update({ dueDate: plus(2) }); expect((await runTrainingJob()).reminded).toBeGreaterThanOrEqual(1); expect((await runTrainingJob()).reminded).toBe(0);
    await tomA.update({ dueDate: plus(-2) });
    const r = await runTrainingJob(); expect(r.overdue).toBeGreaterThanOrEqual(1); expect((await runTrainingJob()).overdue).toBe(0);
    for (const u of [id.tom, id.mia, id.hana]) expect(await M.Notification.count({ where: { userId: u, title: 'Training overdue' } })).toBeGreaterThanOrEqual(1);
    expect((await get('tom', 'training').expect(200)).body.find((a: any) => a.id === tomA.id).status).toBe('overdue');
    const dash = (await get('hana', 'training/compliance').expect(200)).body.find((x: any) => x.title === 'Workplace Safety'); expect(dash.overdue).toBeGreaterThanOrEqual(1); expect(dash.completed).toBe(1);
    await get('mia', 'training/compliance').expect(403);
  });
  it('manager competency review: own team only, evidence required, follow-up for coaching', async () => {
    await post('mia', 'training/competency', { employeeId: id.omar, outcome: 'approved', notes: 'Observed safe practice' }).expect(403);
    await post('mia', 'training/competency', { employeeId: id.mia, outcome: 'approved', notes: 'Observed safe practice' }).expect(403);
    await post('mia', 'training/competency', { employeeId: id.eli, outcome: 'maybe', notes: 'Observed safe practice' }).expect(400); await post('mia', 'training/competency', { employeeId: id.eli, outcome: 'approved', notes: 'ok' }).expect(400);
    await post('mia', 'training/competency', { employeeId: id.eli, outcome: 'coaching', notes: 'Needs help with lifting technique' }).expect(400);
    await post('mia', 'training/competency', { employeeId: id.eli, outcome: 'coaching', notes: 'Needs help with lifting technique', followUpDate: plus(14) }).expect(201);
    expect((await get('eli', 'training/competency').expect(200)).body.length).toBe(1); expect((await get('omar', 'training/competency').expect(200)).body.length).toBe(0);
  });
});
