import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { runAs } from '../src/tenancy';
import { toCsv, safeCell, range } from '../src/reports';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', department: 'Ops', ...extra } as any) as any;
const tok = async (email: string) => (await request(app).post('/api/auth/login').send({ email, password: PW })).body.token as string;
const as = (n: string) => ({ Authorization: 'Bearer ' + T[n] });
let T: Record<string, string> = {}; let id: Record<string, number> = {};
const get = (n: string, path: string) => request(app).get('/api/reports/' + path).set(as(n));
const binary = (res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const ada = await mk('Ada', 'admin'), hana = await mk('Hana', 'hr', { department: 'HR' }), mia = await mk('Mia', 'manager'), eli = await mk('Eli', 'employee', { managerId: mia.id }), omar = await mk('Omar', 'employee'), evil = await mk('=HYPERLINK("http://x")', 'employee', { email: 'evil@t.test' });
  id = { ada: ada.id, hana: hana.id, mia: mia.id, eli: eli.id, omar: omar.id, evil: evil.id };
  for (const [e, h, d] of [[eli, 8, '2026-11-02'], [eli, 7.5, '2026-11-03'], [omar, 8, '2026-11-02'], [mia, 6, '2026-11-02']] as any) await M.Attendance.create({ employeeId: e.id, date: d, hours: h, status: 'present' } as any);
  await M.LeaveBalance.create({ employeeId: eli.id, type: 'Annual', total: 80, used: 16, pending: 8 } as any); await M.LeaveBalance.create({ employeeId: omar.id, type: 'Annual', total: 80 } as any);
  await M.LeaveRequest.create({ employeeId: eli.id, type: 'Annual', startDate: '2026-11-10', endDate: '2026-11-10', hours: 8, status: 'approved' } as any); await M.LeaveRequest.create({ employeeId: omar.id, type: 'Sick', startDate: '2026-11-11', endDate: '2026-11-11', hours: 8, status: 'pending' } as any);
  await M.PaySheet.create({ employeeId: eli.id, period: '2026-10', regularHours: 80, otHours: 2, gross: 1600, net: 1300 } as any);
  await M.AuditLog.create({ actorId: ada.id, action: 'Test Action', detail: 'hello' } as any);
  await runAs(2, () => M.Employee.create({ name: 'Other Company Person', email: 'other@x.test', role: 'employee', password: 'x', status: 'active', department: 'Ops' } as any));
  for (const [n, e] of [['Ada', 'ada@t.test'], ['Hana', 'hana@t.test'], ['Mia', 'mia@t.test'], ['Eli', 'eli@t.test']]) T[n] = await tok(e);
});

describe('formats (pure)', () => {
  it('CSV: BOM, CRLF, quotes escaped, commas and newlines quoted; formula-looking text is neutralised but numbers are not', () => {
    const c = toCsv({ columns: ['A', 'B'], rows: [['x,y', 'say "hi"'], ['=1+1', -5], ['+cmd', '@sum'], ['line\nbreak', null]] });
    expect(c.charCodeAt(0)).toBe(0xfeff); expect(c).toContain('A,B\r\n"x,y","say ""hi"""\r\n'); expect(c).toContain("'=1+1,-5\r\n"); expect(c).toContain("'+cmd,'@sum\r\n"); expect(c).toContain('"line\nbreak",\r\n');
    expect(safeCell(-5)).toBe(-5); expect(safeCell('-5')).toBe("'-5"); expect(safeCell('normal')).toBe('normal');
  });
  it('date range rules', () => {
    expect(() => range({ from: '2026-13-45x' })).toThrow(); expect(() => range({ from: '2026-11-10', to: '2026-11-01' })).toThrow(/before/); expect(() => range({ from: '2024-01-01', to: '2026-01-01' })).toThrow(/one year/);
    expect(range({ from: '2026-11-01', to: '2026-11-30' })).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });
});

describe('who can run which report', () => {
  it('employees get nothing; manager = team reports; HR adds roster / payroll / compliance; only admin gets the audit log', async () => {
    await request(app).get('/api/reports').set(as('Eli')).expect(403); await get('Eli', 'headcount').expect(403);
    const keys = async (n: string) => ((await request(app).get('/api/reports').set(as(n)).expect(200)).body as any[]).map((r) => r.key).sort();
    expect(await keys('Mia')).toEqual(['attendance', 'headcount', 'leave_balances', 'leave_requests', 'timesheets']);
    expect(await keys('Hana')).toEqual(['attendance', 'compliance', 'headcount', 'leave_balances', 'leave_requests', 'payroll', 'roster', 'timesheets']);
    expect((await keys('Ada')).includes('audit')).toBe(true);
    for (const k of ['payroll', 'roster', 'compliance', 'audit']) await get('Mia', k).expect(403); await get('Hana', 'audit').expect(403);
    await get('Ada', 'nope').expect(404); await get('Ada', 'constructor').expect(404); await get('Ada', '__proto__').expect(404);
  });
  it('unauthenticated requests are refused', async () => { await request(app).get('/api/reports/headcount').expect(401); });
});

describe('report contents', () => {
  it('HR sees the whole company and nothing from another company', async () => {
    const h = (await get('Hana', 'headcount').expect(200)).body; expect(h.columns).toEqual(['Department', 'Type', 'Status', 'People']); expect(h.rows.reduce((n: number, r: any[]) => n + r[3], 0)).toBe(6);   // 6 people in company 1; the company 2 person is not counted
    const r = (await get('Hana', 'roster').expect(200)).body; expect(r.total).toBe(6); expect(JSON.stringify(r)).not.toContain('Other Company'); expect(r.columns).not.toContain('Password'); expect(JSON.stringify(r)).not.toMatch(/\$2[aby]\$/);
    expect(r.columns.some((c: string) => /salary|rate|pay/i.test(c))).toBe(false);
  });
  it('a manager sees only the team in every scoped report', async () => {
    const a = (await get('Mia', 'attendance?from=2026-11-01&to=2026-11-30').expect(200)).body; expect(a.rows.map((x: any[]) => x[0]).sort()).toEqual(['Eli', 'Mia']);
    expect(a.rows.find((x: any[]) => x[0] === 'Eli').slice(1)).toEqual([2, 0, 15.5]);
    const b = (await get('Mia', 'leave_balances').expect(200)).body; expect(b.rows).toEqual([['Eli', 'Annual', 80, 16, 8, 56]]);
    const l = (await get('Mia', 'leave_requests?from=2026-11-01&to=2026-11-30').expect(200)).body; expect(l.rows.map((x: any[]) => x[0])).toEqual(['Eli']);
    expect((await get('Mia', 'headcount').expect(200)).body.rows.reduce((n: number, r: any[]) => n + r[3], 0)).toBe(2);
  });
  it('payroll by period; audit by range', async () => {
    const p = (await get('Hana', 'payroll?period=2026-10').expect(200)).body; expect(p.rows).toEqual([['Eli', '2026-10', 80, 2, 1600, 0, 0, 0, 1300]]); expect((await get('Hana', 'payroll?period=2026-09').expect(200)).body.rows).toEqual([]);
    const a = (await get('Ada', 'audit').expect(200)).body; expect(a.rows.some((r: any[]) => r[2] === 'Test Action' && r[1] === 'Ada')).toBe(true);
  });
  it('bad parameters are 400, not 500', async () => {
    await get('Hana', 'attendance?from=banana').expect(400); await get('Hana', 'attendance?from=2026-11-30&to=2026-11-01').expect(400); await get('Hana', 'attendance?from=2020-01-01&to=2026-11-01').expect(400);
    await get('Hana', 'payroll?period=Nov').expect(400); await get('Hana', 'headcount?format=pdf').expect(400);
  });
});

describe('exports', () => {
  it('CSV download: right headers, BOM, formula text neutralised, and the export is audited', async () => {
    const r = await get('Hana', 'roster?format=csv').expect(200); expect(r.headers['content-type']).toMatch(/text\/csv/); expect(r.headers['content-disposition']).toMatch(/attachment; filename="roster-\d{4}-\d{2}-\d{2}\.csv"/); expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text.charCodeAt(0)).toBe(0xfeff); expect(r.text).toContain('ID,Name,Email'); expect(r.text).toContain(`'=HYPERLINK(""http://x"")`); expect(r.text).not.toContain(',=HYPERLINK');
    const a = ((await get('Ada', 'audit?from=2000-01-01').expect(400)), (await get('Ada', 'audit').expect(200)).body.rows); expect(a.some((x: any[]) => x[2] === 'Report Exported' && /roster csv/.test(x[3]))).toBe(true);
  });
  it('Excel download is a real .xlsx with a bold frozen header, numeric cells and neutralised text', async () => {
    const r = await get('Hana', 'payroll?period=2026-10&format=xlsx').buffer(true).parse(binary).expect(200); expect(r.headers['content-type']).toContain('spreadsheetml.sheet'); expect(r.headers['content-disposition']).toMatch(/\.xlsx"/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body); const ws = wb.worksheets[0]; expect(ws.getRow(1).getCell(1).value).toBe('Employee'); expect(ws.getRow(1).font?.bold).toBe(true); expect(ws.getRow(2).getCell(9).value).toBe(1300); expect(ws.getRow(2).getCell(1).value).toBe('Eli');
    const ro = await get('Hana', 'roster?format=xlsx').buffer(true).parse(binary).expect(200); const w2 = new ExcelJS.Workbook(); await w2.xlsx.load(ro.body); const names = w2.worksheets[0].getColumn(2).values as any[]; expect(names.some((v) => v === `'=HYPERLINK("http://x")`)).toBe(true);
  });
  it('a manager exporting is limited to the same scope and role rules', async () => {
    const r = await get('Mia', 'leave_balances?format=csv').expect(200); expect(r.text).toContain('Eli'); expect(r.text).not.toContain('Omar'); await get('Mia', 'payroll?format=csv').expect(403);
  });
});
