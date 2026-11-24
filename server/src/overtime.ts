// Deterministic overtime engine (P1). Pure function: no AI, no DB.
export interface Shift { workDate: string; minutes: number }
export interface OtRule { weeklyOtAfterMin: number; dailyOtAfterMin: number | null; dailyDtAfterMin: number | null }
export function weekKey(date: string): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10);
}
export function classify(shifts: Shift[], rule: OtRule) {
  const byDay = new Map<string, number>();
  for (const s of shifts) byDay.set(s.workDate, (byDay.get(s.workDate) ?? 0) + Math.max(0, s.minutes));
  const weekReg = new Map<string, number>(); const out = { regularMin: 0, otMin: 0, dtMin: 0 };
  for (const [date, minutes] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let rem = minutes, dt = 0, ot = 0;
    if (rule.dailyDtAfterMin !== null && rem > rule.dailyDtAfterMin) { dt = rem - rule.dailyDtAfterMin; rem = rule.dailyDtAfterMin; }
    if (rule.dailyOtAfterMin !== null && rem > rule.dailyOtAfterMin) { ot = rem - rule.dailyOtAfterMin; rem = rule.dailyOtAfterMin; }
    const wk = weekKey(date), used = weekReg.get(wk) ?? 0, allowed = Math.max(0, rule.weeklyOtAfterMin - used);
    let reg = rem; if (reg > allowed) { ot += reg - allowed; reg = allowed; }
    weekReg.set(wk, used + reg); out.regularMin += reg; out.otMin += ot; out.dtMin += dt;
  }
  return out;
}
export const toHours = (min: number) => Math.round((min / 60) * 100) / 100;
// Federal baseline (FLSA 40h/week) + California daily OT/double time. Add other states only after legal review.
export const OT_RULES: Record<string, OtRule> = {
  '*': { weeklyOtAfterMin: 2400, dailyOtAfterMin: null, dailyDtAfterMin: null },
  CA: { weeklyOtAfterMin: 2400, dailyOtAfterMin: 480, dailyDtAfterMin: 720 },
};
export const otRuleFor = (state?: string) => OT_RULES[(state || '').toUpperCase()] ?? OT_RULES['*'];
