import * as M from './models';
export const log = (actorId: number, action: string, detail = '') => M.AuditLog.create({ actorId, action, detail });
// P2: balance check -> auto reject or reserve pending hours
export async function submitLeave(userId: number, b: { type: string; startDate: string; endDate: string; hours: number; reason?: string }) {
  if (b.type === 'Sick') { // P16 validation: qualifying reason + waiting period
    const emp: any = await M.Employee.findByPk(userId);
    const rule = sickRule(emp?.workState);
    const ok = SICK_REASONS.includes(b.reason || '');
    const eligibleFrom = new Date(new Date(emp?.startDate || Date.now()).getTime() + rule.waitingDays * 864e5).toISOString().slice(0, 10);
    const why = !ok ? 'Reason is not a qualifying sick leave reason' : b.startDate < eligibleFrom ? `Waiting period: sick leave can be used from ${eligibleFrom}` : '';
    if (why) return M.LeaveRequest.create({ employeeId: userId, ...b, status: 'rejected', comment: 'Auto rejected: ' + why });
  }
  const bal: any = await M.LeaveBalance.findOne({ where: { employeeId: userId, type: b.type } });
  const avail = bal ? bal.total - bal.used - bal.pending : 0;
  if (b.type !== 'Unpaid' && avail < b.hours) return M.LeaveRequest.create({ employeeId: userId, ...b, status: 'rejected', comment: 'Auto rejected: insufficient balance' });
  if (bal) { bal.pending += +b.hours; await bal.save(); }
  await log(userId, 'Leave Requested', `${b.type} ${b.hours}h`);
  return M.LeaveRequest.create({ employeeId: userId, ...b });
}

// P16: paid sick hours per year by work state (2026 mandates, see Appendix A2). Others use company policy default.
const SICK: Record<string, number> = { AK: 56, AZ: 40, CA: 40, CO: 48, CT: 40, DC: 56, IL: 40, ME: 40, MD: 40, MA: 40, MI: 72, MN: 48, NE: 40, NV: 40, NJ: 40, NM: 64, NY: 56, OR: 40, RI: 40, VT: 40, WA: 40 };
export const sickHours = (state: string) => SICK[(state || '').toUpperCase()] ?? 40;
// P17: federal + state exempt salary floors, annual (Appendix A4)
export const SALARY_FLOOR: Record<string, number> = { US: 35568, CA: 70304, WA: 80168.4, NY: 62353.2, CO: 57783.96, ME: 45300.32 };

export const SICK_REASONS = ['Own illness or injury', 'Care for family member', 'Preventive or medical care', 'Safe leave (domestic violence, stalking)', 'Public health closure', 'Bereavement', 'Blood donation (OR)'];
const RATE: Record<string, number> = { DC: 37, IL: 40, ME: 40, NV: 52, VT: 52, RI: 35, WA: 40 };
// P16 rule set per jurisdiction (Appendix A3 fields). Waiting period: most states allow up to 90 days; use 0 where earned from day one is common.
export const sickRule = (state: string) => { const st = (state || '').toUpperCase(), mandated = st in SICK;
  return { state: st, mandated, annualHours: sickHours(st), accrual: mandated ? `1 hour per ${RATE[st] || 30} hours worked` : 'Company policy', carryover: mandated ? 'Up to 40 hours' : 'Company policy', waitingDays: mandated ? 0 : 90, reasons: SICK_REASONS, note: mandated ? 'Statewide paid sick leave law applies. A stricter city or county law may also apply.' : 'No statewide mandate. Company policy applies unless a local law does.' }; };
// P15 plan catalog: monthly premiums by coverage level, employer share %
export const PLANS = [
  { code: 'medical', name: 'Medical (PPO)', employerPct: 70, minHours: 30, preTax: true, cost: { employee: 480, spouse: 960, children: 880, family: 1380 } },
  { code: 'dental', name: 'Dental', employerPct: 50, minHours: 30, preTax: true, cost: { employee: 38, spouse: 76, children: 82, family: 124 } },
  { code: 'vision', name: 'Vision', employerPct: 50, minHours: 20, preTax: true, cost: { employee: 12, spouse: 24, children: 26, family: 40 } },
  { code: 'life', name: 'Life and AD&D (1x salary)', employerPct: 100, minHours: 20, preTax: false, cost: { employee: 15, spouse: 15, children: 15, family: 15 } },
  { code: 'disability', name: 'Short and long-term disability', employerPct: 60, minHours: 30, preTax: false, cost: { employee: 28, spouse: 28, children: 28, family: 28 } },
  { code: 'hsa', name: 'HSA / FSA', employerPct: 0, minHours: 30, preTax: true, cost: { employee: 0, spouse: 0, children: 0, family: 0 } },
];

import { Op } from 'sequelize';
export class HttpErr extends Error { constructor(public status: number, public code: string) { super(code); } }
export const isHR = (u: any) => ['admin', 'hr'].includes(u.role);
export const isStaff = (u: any) => u.role !== 'employee';
/** All direct and indirect reports of a manager. */
export async function teamOf(uid: number): Promise<number[]> {
  const out = new Set<number>(); let frontier = [uid];
  while (frontier.length) {
    const rows: any[] = await M.Employee.findAll({ where: { managerId: { [Op.in]: frontier } }, attributes: ['id'], raw: true });
    frontier = rows.map((r) => r.id).filter((i) => i !== uid && !out.has(i)); frontier.forEach((i) => out.add(i));
  }
  return [...out];
}
/** Employee ids the user may read. null = everyone (HR/admin). */
export async function scopeIds(u: any): Promise<number[] | null> {
  if (isHR(u)) return null;
  return u.role === 'manager' ? [u.id, ...(await teamOf(u.id))] : [u.id];
}
export const inScope = (ids: number[] | null) => (ids ? { employeeId: { [Op.in]: ids } } : {});
/** May `u` act (approve/reject) on `employeeId`'s item? Never on their own. */
export async function approverCheck(u: any, employeeId: number): Promise<'ok' | 'self' | 'forbidden'> {
  if (u.id === employeeId) return 'self';
  if (isHR(u)) return 'ok';
  if (u.role === 'manager' && (await teamOf(u.id)).includes(employeeId)) return 'ok';
  return 'forbidden';
}
