/** Pure rules for P16 paid sick leave accrual (A2/A3) and P15 enrollment windows. Seed values come from the BPMN Appendix A2 and are UNVERIFIED defaults for HR/counsel to confirm. */
export interface PslValue {
  hoursPerWorked: number;                 // 1 hour of leave per N hours worked
  accrualCapHours: number | null;         // annual accrual cap (null = none)
  useCapHours?: number | null; carryoverHours: number | null; waitingDays: number;
  minEmployeesPaid: number | null;        // below this employer size the leave is unpaid / company policy
  tiers?: { minEmployees: number; hoursPerWorked?: number; accrualCapHours?: number | null }[];   // employer-size tiers (largest minEmployees <= size wins)
  note?: string;
}
export function pslEffective(v: PslValue, employerSize: number) {
  const t = (v.tiers || []).filter((x) => employerSize >= x.minEmployees).sort((a, b) => b.minEmployees - a.minEmployees)[0];
  return { hoursPerWorked: t?.hoursPerWorked ?? v.hoursPerWorked, accrualCapHours: t && 'accrualCapHours' in t ? t.accrualCapHours ?? null : v.accrualCapHours };
}
export function pslAccrue(a: { rule: PslValue; employerSize: number; hoursWorked: number; accruedThisYear: number }) {
  const review: string[] = [];
  if (a.rule.minEmployeesPaid != null && a.employerSize < a.rule.minEmployeesPaid) return { accrued: 0, capped: false, paid: false, review: [`Employer size ${a.employerSize} is below ${a.rule.minEmployeesPaid}: company policy / unpaid protected leave applies`] };
  const e = pslEffective(a.rule, a.employerSize);
  if (!(e.hoursPerWorked > 0)) return { accrued: 0, capped: false, paid: true, review: ['The rule has no valid accrual rate'] };
  const raw = Math.floor((Math.max(0, a.hoursWorked) / e.hoursPerWorked) * 100) / 100;
  const room = e.accrualCapHours == null ? Infinity : Math.max(0, e.accrualCapHours - a.accruedThisYear), accrued = Math.floor(Math.min(raw, room) * 100) / 100;
  return { accrued, capped: raw > room, paid: true, review };
}
export const pslUsableFrom = (startDate: string, waitingDays: number) => new Date(new Date(startDate + 'T00:00:00Z').getTime() + waitingDays * 864e5).toISOString().slice(0, 10);
export function pslYearEnd(rule: PslValue, balance: number) {
  const review = rule.carryoverHours == null ? ['The rule does not state a carryover: confirm before the year-end reset'] : [];
  return { carry: Math.round((rule.carryoverHours == null ? balance : Math.min(balance, rule.carryoverHours)) * 100) / 100, review };
}
const S = (hoursPerWorked: number, accrualCapHours: number | null, extra: Partial<PslValue> = {}): PslValue => ({ hoursPerWorked, accrualCapHours, carryoverHours: null, waitingDays: 0, minEmployeesPaid: null, ...extra });
/** Appendix A2: states and DC with a mandate. Days are converted at 8 hours. Items the PDF itself marks "verify" are noted. */
export const PSL_SEED: { jurisdiction: string; value: PslValue }[] = [
  { jurisdiction: 'AK', value: S(30, 40, { tiers: [{ minEmployees: 15, accrualCapHours: 56 }], note: 'A2: 56 hrs (15+ employees); 40 hrs (under 15)' }) },
  { jurisdiction: 'AZ', value: S(30, 24, { tiers: [{ minEmployees: 15, accrualCapHours: 40 }], note: 'A2: 40 hrs (15+); 24 hrs (under 15)' }) },
  { jurisdiction: 'CA', value: S(30, 80, { useCapHours: 40, note: 'A2: accrual cap 80 hrs / 10 days; use at least 40 hrs / 5 days; or front-load. Many city ordinances apply' }) },
  { jurisdiction: 'CO', value: S(30, 48, { note: 'A2: 48 hrs; extra 80 hrs in a declared public health emergency' }) },
  { jurisdiction: 'CT', value: S(30, 40, { carryoverHours: 40, minEmployeesPaid: 11, note: 'A2: 11+ employees in 2026; all employers from 1 Jan 2027 (check phase-in dates)' }) },
  { jurisdiction: 'DC', value: S(87, 24, { tiers: [{ minEmployees: 25, hoursPerWorked: 43, accrualCapHours: 40 }, { minEmployees: 100, hoursPerWorked: 37, accrualCapHours: 56 }], note: 'A2: 1 hr per 37 (100+), 43 (25-99), 87 (24 or fewer); cap 7/5/3 days (converted at 8 h). Safe leave included' }) },
  { jurisdiction: 'IL', value: S(40, 40, { note: 'A2: leave for any reason; employers outside Chicago and Cook County' }) },
  { jurisdiction: 'ME', value: S(40, 40, { minEmployeesPaid: 11, note: 'A2: more than 10 employees (some sources say 10+; VERIFY); leave for any reason' }) },
  { jurisdiction: 'MD', value: S(30, 40, { minEmployeesPaid: 15, note: 'A2: earn 40 hrs; use and bank up to 64 hrs; paid for 15+ employees, unpaid under 15' }) },
  { jurisdiction: 'MA', value: S(30, 40, { minEmployeesPaid: 11, note: 'A2: paid 11+ employees; unpaid under 11' }) },
  { jurisdiction: 'MI', value: S(30, 40, { tiers: [{ minEmployees: 11, accrualCapHours: 72 }], note: 'A2: 72 hrs (larger employers); 40 hrs (small, about 10 or fewer)' }) },
  { jurisdiction: 'MN', value: S(30, 48, { note: 'A2: Minneapolis and Saint Paul have local rules' }) },
  { jurisdiction: 'NE', value: S(30, 40, { minEmployeesPaid: 11, note: 'A2: 11+ employees in most sources; smaller employers have a lower cap (VERIFY); unused time carries over' }) },
  { jurisdiction: 'NV', value: S(52, 40, { minEmployeesPaid: 50, note: 'A2: about 1 hr per 52 worked (0.01923/hr), about 40 hrs; employers with 50+ employees; leave for any reason' }) },
  { jurisdiction: 'NJ', value: S(30, 40, { note: 'A2: front-load allowed' }) },
  { jurisdiction: 'NM', value: S(30, 64, { note: 'A2: Bernalillo County has local rules' }) },
  { jurisdiction: 'NY', value: S(30, 40, { tiers: [{ minEmployees: 100, accrualCapHours: 56 }], note: 'A2: 40 hrs (under 100 employees); 56 hrs (100+). NYC and Westchester have their own laws' }) },
  { jurisdiction: 'OR', value: S(30, 40, { minEmployeesPaid: 10, note: 'A2: paid for 10+ employees (6+ in Portland); smaller employers unpaid' }) },
  { jurisdiction: 'RI', value: S(35, 40, { minEmployeesPaid: 18, note: 'A2: paid 18+ employees; unpaid under 18' }) },
  { jurisdiction: 'VT', value: S(52, 40, { note: 'A2: all employers (phased in by size)' }) },
  { jurisdiction: 'WA', value: S(40, null, { carryoverHours: 40, note: 'A2: no annual accrual cap; carryover up to 40 hrs. Seattle and Tacoma add local rules' }) },
];

// ---- P15 enrollment windows
export interface WindowInput { today: string; eligibleDate: string; windowDays: number; openWindows: { startDate: string; endDate: string }[]; lifeEvents: { eventDate: string; windowDays?: number }[] }
const plus = (d: string, n: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
/** Hire, open enrollment or a qualifying life event (marriage, birth/adoption, loss of other coverage: normally a 30-day window per plan). */
export function windowState(a: WindowInput): { open: boolean; reason: 'new_hire' | 'open_enrollment' | 'life_event' | null; closesOn: string | null } {
  const hits: { reason: 'new_hire' | 'open_enrollment' | 'life_event'; closes: string }[] = [];
  if (a.today >= a.eligibleDate && a.today <= plus(a.eligibleDate, a.windowDays)) hits.push({ reason: 'new_hire', closes: plus(a.eligibleDate, a.windowDays) });
  for (const w of a.openWindows) if (a.today >= w.startDate && a.today <= w.endDate) hits.push({ reason: 'open_enrollment', closes: w.endDate });
  for (const l of a.lifeEvents) { const end = plus(l.eventDate, l.windowDays ?? 30); if (a.today >= l.eventDate && a.today <= end) hits.push({ reason: 'life_event', closes: end }); }
  if (!hits.length) return { open: false, reason: null, closesOn: null };
  const best = hits.sort((x, y) => y.closes.localeCompare(x.closes))[0]; return { open: true, reason: best.reason, closesOn: best.closes };
}
export const LIFE_EVENTS = ['marriage', 'birth_adoption', 'loss_of_coverage'] as const;
export const quarterOf = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
