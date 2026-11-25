"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.otRuleFor = exports.OT_RULES = exports.toHours = void 0;
exports.weekKey = weekKey;
exports.classify = classify;
function weekKey(date) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}
function classify(shifts, rule) {
    const byDay = new Map();
    for (const s of shifts)
        byDay.set(s.workDate, (byDay.get(s.workDate) ?? 0) + Math.max(0, s.minutes));
    const weekReg = new Map();
    const out = { regularMin: 0, otMin: 0, dtMin: 0 };
    for (const [date, minutes] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        let rem = minutes, dt = 0, ot = 0;
        if (rule.dailyDtAfterMin !== null && rem > rule.dailyDtAfterMin) {
            dt = rem - rule.dailyDtAfterMin;
            rem = rule.dailyDtAfterMin;
        }
        if (rule.dailyOtAfterMin !== null && rem > rule.dailyOtAfterMin) {
            ot = rem - rule.dailyOtAfterMin;
            rem = rule.dailyOtAfterMin;
        }
        const wk = weekKey(date), used = weekReg.get(wk) ?? 0, allowed = Math.max(0, rule.weeklyOtAfterMin - used);
        let reg = rem;
        if (reg > allowed) {
            ot += reg - allowed;
            reg = allowed;
        }
        weekReg.set(wk, used + reg);
        out.regularMin += reg;
        out.otMin += ot;
        out.dtMin += dt;
    }
    return out;
}
const toHours = (min) => Math.round((min / 60) * 100) / 100;
exports.toHours = toHours;
// Federal baseline (FLSA 40h/week) + California daily OT/double time. Add other states only after legal review.
exports.OT_RULES = {
    '*': { weeklyOtAfterMin: 2400, dailyOtAfterMin: null, dailyDtAfterMin: null },
    CA: { weeklyOtAfterMin: 2400, dailyOtAfterMin: 480, dailyDtAfterMin: 720 },
};
const otRuleFor = (state) => exports.OT_RULES[(state || '').toUpperCase()] ?? exports.OT_RULES['*'];
exports.otRuleFor = otRuleFor;
