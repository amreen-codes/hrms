/** Reports and exports (JSON preview, CSV, Excel). Every report is scoped with the same rules as the REST API: HR/admin see the company, a manager sees the team, and the sensitive reports (roster, payroll, compliance, audit) are HR/admin only. Exports are audited. */
import { Router } from 'express';
import { Op } from 'sequelize';
import ExcelJS from 'exceljs';
import * as M from './models';
import { isHR, isStaff, scopeIds, inScope, log } from './services';
import { wrap, bad } from './http';

type Cell = string | number | null;
interface Table { columns: string[]; rows: Cell[][] }
interface Params { from?: string; to?: string; period?: string }
interface Def { title: string; description: string; access: 'staff' | 'hr' | 'admin'; params: ('range' | 'period')[]; build(u: any, p: Params, ids: number[] | null): Promise<Table> }
const MAX_ROWS = 20000, PREVIEW_ROWS = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/, PERIOD = /^\d{4}-\d{2}$/;
const num = (v: any) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const day = (v: any) => (v ? String(v).slice(0, 10) : null);
const nameMap = async (ids: number[]) => new Map(((await M.Employee.findAll({ where: { id: { [Op.in]: [...new Set(ids)] } }, attributes: ['id', 'name'], raw: true })) as any[]).map((e) => [e.id, e.name as string]));
const empWhere = (ids: number[] | null) => (ids ? { id: { [Op.in]: ids } } : {});

export function range(p: Params): { from: string; to: string } {
  const to = p.to || new Date().toISOString().slice(0, 10), from = p.from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  if (!DATE.test(from) || !DATE.test(to) || isNaN(+new Date(from)) || isNaN(+new Date(to))) throw bad('Dates must look like 2026-11-30');
  if (to < from) throw bad('The end date is before the start date');
  if ((+new Date(to) - +new Date(from)) / 864e5 > 366) throw bad('Choose a range of at most one year');
  return { from, to };
}

export const REPORTS: Record<string, Def> = {
  headcount: { title: 'Headcount by department', description: 'People per department, employment type and status.', access: 'staff', params: [],
    async build(_u, _p, ids) {
      const rows: any[] = await M.Employee.findAll({ where: empWhere(ids), attributes: ['department', 'type', 'status'], raw: true }); const g = new Map<string, number>();
      for (const r of rows) { const k = [r.department || '(none)', r.type, r.status].join('|'); g.set(k, (g.get(k) || 0) + 1); }
      return { columns: ['Department', 'Type', 'Status', 'People'], rows: [...g].sort().map(([k, n]) => [...(k.split('|') as Cell[]), n]) };
    } },
  roster: { title: 'Employee roster', description: 'Name, contact, department, title, manager, status and start date. No pay, no personal documents.', access: 'hr', params: [],
    async build() {
      const rows: any[] = await M.Employee.findAll({ attributes: ['id', 'name', 'email', 'role', 'department', 'title', 'type', 'status', 'startDate', 'workState', 'managerId'], order: [['name', 'ASC']], limit: MAX_ROWS + 1, raw: true }); const nm = await nameMap(rows.map((r) => r.managerId).filter(Boolean));
      return { columns: ['ID', 'Name', 'Email', 'Role', 'Department', 'Title', 'Type', 'Status', 'Start date', 'State', 'Manager'], rows: rows.map((r) => [r.id, r.name, r.email, r.role, r.department, r.title, r.type, r.status, day(r.startDate), r.workState, nm.get(r.managerId) ?? null]) };
    } },
  attendance: { title: 'Attendance summary', description: 'Days present and hours worked per person in a date range.', access: 'staff', params: ['range'],
    async build(_u, p, ids) {
      const { from, to } = range(p); const rows: any[] = await M.Attendance.findAll({ where: { date: { [Op.between]: [from, to] }, ...inScope(ids) }, attributes: ['employeeId', 'date', 'hours', 'status'], raw: true });
      const nm = await nameMap(rows.map((r) => r.employeeId)); const g = new Map<number, { days: Set<string>; hours: number; absent: number }>();
      for (const r of rows) { const x = g.get(r.employeeId) || { days: new Set<string>(), hours: 0, absent: 0 }; if (r.status === 'present') x.days.add(String(r.date)); if (r.status === 'absent') x.absent++; x.hours += num(r.hours); g.set(r.employeeId, x); }
      return { columns: ['Employee', 'Days present', 'Days absent', 'Hours worked'], rows: [...g].map(([id, x]) => [nm.get(id) || `#${id}`, x.days.size, x.absent, num(x.hours)] as Cell[]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
    } },
  leave_requests: { title: 'Leave requests', description: 'Every leave request that starts in the date range, with its status.', access: 'staff', params: ['range'],
    async build(_u, p, ids) {
      const { from, to } = range(p); const rows: any[] = await M.LeaveRequest.findAll({ where: { startDate: { [Op.between]: [from, to] }, ...inScope(ids) }, order: [['startDate', 'ASC']], limit: MAX_ROWS + 1, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId));
      return { columns: ['Employee', 'Type', 'Start', 'End', 'Hours', 'Status', 'Comment'], rows: rows.map((r) => [nm.get(r.employeeId) || `#${r.employeeId}`, r.type, day(r.startDate), day(r.endDate), r.hours, r.status, r.comment ?? null]) };
    } },
  leave_balances: { title: 'Leave balances', description: 'Total, used, pending and remaining leave hours per person and type.', access: 'staff', params: [],
    async build(_u, _p, ids) {
      const rows: any[] = await M.LeaveBalance.findAll({ where: inScope(ids), limit: MAX_ROWS + 1, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId));
      return { columns: ['Employee', 'Type', 'Total (h)', 'Used (h)', 'Pending (h)', 'Remaining (h)'], rows: rows.map((r) => [nm.get(r.employeeId) || `#${r.employeeId}`, r.type, r.total, r.used, r.pending, r.total - r.used - r.pending] as Cell[]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))) };
    } },
  timesheets: { title: 'Timesheet hours', description: 'Regular, overtime and double-time hours per submitted timesheet.', access: 'staff', params: ['range'],
    async build(_u, p, ids) {
      const { from, to } = range(p); const rows: any[] = await M.Timesheet.findAll({ where: { periodStart: { [Op.lte]: to }, periodEnd: { [Op.gte]: from }, ...inScope(ids) }, order: [['periodStart', 'ASC']], limit: MAX_ROWS + 1, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId));
      return { columns: ['Employee', 'Period start', 'Period end', 'Regular (h)', 'Overtime (h)', 'Double time (h)', 'Status'], rows: rows.map((r) => [nm.get(r.employeeId) || `#${r.employeeId}`, day(r.periodStart), day(r.periodEnd), num(r.regularHours), num(r.otHours), num(r.dtHours), r.status]) };
    } },
  payroll: { title: 'Payroll summary', description: 'Gross, commission, bonus, deductions and net pay per person for a pay period (YYYY-MM).', access: 'hr', params: ['period'],
    async build(_u, p) {
      if (p.period && !PERIOD.test(p.period)) throw bad('Period must look like 2026-11');
      const rows: any[] = await M.PaySheet.findAll({ where: p.period ? { period: p.period } : {}, order: [['period', 'DESC'], ['id', 'ASC']], limit: MAX_ROWS + 1, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId));
      return { columns: ['Employee', 'Period', 'Regular (h)', 'Overtime (h)', 'Gross', 'Commission', 'Bonus', 'Deductions', 'Net'], rows: rows.map((r) => [nm.get(r.employeeId) || `#${r.employeeId}`, r.period, num(r.regularHours), num(r.otHours), num(r.gross), num(r.commission), num(r.bonus), num(r.deductions), num(r.net)]) };
    } },
  compliance: { title: 'Compliance tasks', description: 'Open, overdue, done and waived compliance tasks.', access: 'hr', params: [],
    async build() {
      const rows: any[] = await M.ComplianceTask.findAll({ order: [['dueDate', 'ASC']], limit: MAX_ROWS + 1, raw: true }); const nm = await nameMap(rows.map((r) => r.employeeId).filter(Boolean));
      return { columns: ['Employee', 'Task', 'Due', 'Status'], rows: rows.map((r) => [nm.get(r.employeeId) ?? null, r.type, day(r.dueDate), r.status]) };
    } },
  audit: { title: 'Audit log', description: 'Who did what, and when, in a date range (admin only).', access: 'admin', params: ['range'],
    async build(_u, p) {
      const { from, to } = range(p); const rows: any[] = await M.AuditLog.findAll({ where: { createdAt: { [Op.between]: [new Date(from + 'T00:00:00Z'), new Date(to + 'T23:59:59Z')] } }, order: [['id', 'DESC']], limit: MAX_ROWS + 1, raw: true }); const nm = await nameMap(rows.map((r) => r.actorId).filter(Boolean));
      return { columns: ['When (UTC)', 'Person', 'Action', 'Detail'], rows: rows.map((r) => [new Date(r.createdAt).toISOString().replace('T', ' ').slice(0, 19), nm.get(r.actorId) ?? null, r.action, r.detail ?? null]) };
    } },
};
const allowed = (d: Def, u: any) => (d.access === 'staff' ? isStaff(u) : d.access === 'hr' ? isHR(u) : u.role === 'admin');

// ---------------------------------------------------------------- formats
/** Spreadsheet programs run text that starts with = + - @ (tab / CR) as a formula. Prefix such TEXT with a quote. Numbers are untouched. */
export const safeCell = (v: Cell): Cell => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
export function toCsv(t: Table): string {
  const q = (v: Cell) => { const s = v === null || v === undefined ? '' : String(safeCell(v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '\uFEFF' + [t.columns, ...t.rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';          // BOM so Excel reads UTF-8 names correctly
}
export async function toXlsx(title: string, t: Table): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); wb.creator = 'AMS HRMS'; wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(t.columns).font = { bold: true }; for (const r of t.rows) ws.addRow(r.map(safeCell));
  t.columns.forEach((c, i) => { const w = Math.max(c.length, ...t.rows.slice(0, 200).map((r) => String(r[i] ?? '').length)); ws.getColumn(i + 1).width = Math.min(48, w + 2); });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const reportsRouter = Router();
reportsRouter.get('/reports', wrap(async (q, s) => {
  if (!isStaff(q.user)) throw bad('Not allowed for your role', 403);
  s.json(Object.entries(REPORTS).filter(([, d]) => allowed(d, q.user)).map(([key, d]) => ({ key, title: d.title, description: d.description, params: d.params })));
}));
reportsRouter.get('/reports/:key', wrap(async (q, s) => {
  const d = Object.prototype.hasOwnProperty.call(REPORTS, q.params.key) ? REPORTS[q.params.key] : null;
  if (!d) throw bad('Unknown report', 404);
  if (!allowed(d, q.user)) throw bad('Not allowed for your role', 403);
  const format = String(q.query.format || 'json'); if (!['json', 'csv', 'xlsx'].includes(format)) throw bad('Format must be json, csv or xlsx');
  const p: Params = { from: q.query.from ? String(q.query.from) : undefined, to: q.query.to ? String(q.query.to) : undefined, period: q.query.period ? String(q.query.period) : undefined };
  const t = await d.build(q.user, p, await scopeIds(q.user)); const truncated = t.rows.length > MAX_ROWS; if (truncated) t.rows = t.rows.slice(0, MAX_ROWS);
  if (format === 'json') return s.json({ key: q.params.key, title: d.title, columns: t.columns, rows: t.rows.slice(0, PREVIEW_ROWS), total: t.rows.length, previewOnly: t.rows.length > PREVIEW_ROWS, truncated });
  await log(q.user.id, 'Report Exported', `${q.params.key} ${format} ${[p.from, p.to, p.period].filter(Boolean).join(' ')} rows=${t.rows.length}`.trim());
  const file = `${q.params.key}-${new Date().toISOString().slice(0, 10)}.${format}`;
  s.setHeader('Content-Disposition', `attachment; filename="${file}"`); s.setHeader('Cache-Control', 'no-store'); s.setHeader('X-Content-Type-Options', 'nosniff');
  if (truncated) s.setHeader('X-Report-Truncated', 'true');
  if (format === 'csv') { s.type('text/csv; charset=utf-8'); return s.send(toCsv(t)); }
  s.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); s.send(await toXlsx(d.title, t));
}));
