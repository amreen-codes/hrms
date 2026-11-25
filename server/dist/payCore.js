"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERIFY_FLOOR_STATES = exports.creditedSales = void 0;
exports.validatePlan = validatePlan;
exports.commissionFor = commissionFor;
exports.applyDraw = applyDraw;
exports.clawbackLine = clawbackLine;
exports.otPremiumOnExtras = otPremiumOnExtras;
exports.supplementalWithholding = supplementalWithholding;
exports.clawbackDecision = clawbackDecision;
exports.exemptFloor = exemptFloor;
exports.checkPay = checkPay;
function validatePlan(p) {
    const e = [];
    if (p.kind === 'flat') {
        if (p.rate == null || !(p.rate >= 0 && p.rate <= 1))
            e.push('Flat rate must be between 0 and 100%');
    }
    else {
        const t = p.tiers || [];
        if (!t.length)
            e.push('Tiered plan needs at least one tier');
        let prev = 0;
        t.forEach((x, i) => {
            if (!(x.rate >= 0 && x.rate <= 1))
                e.push(`Tier ${i + 1}: rate must be between 0 and 100%`);
            if (x.upTo == null) {
                if (i !== t.length - 1)
                    e.push('Only the last tier can be open-ended');
            }
            else {
                if (x.upTo <= prev)
                    e.push(`Tier ${i + 1}: limit must be higher than the previous tier`);
                prev = x.upTo;
            }
        });
        if (t.length && t[t.length - 1].upTo != null)
            e.push('The last tier must be open-ended');
    }
    if (p.capCents != null && p.capCents < 0)
        e.push('Cap cannot be negative');
    return e;
}
const creditedSales = (sales) => sales.reduce((a, s) => a + Math.round(s.amountCents * ((s.splitPct ?? 100) / 100)), 0);
exports.creditedSales = creditedSales;
/** Commission for the period's credited sales. Tiers are marginal. The cap applies last. */
function commissionFor(credited, plan) {
    let c = 0;
    if (plan.kind === 'flat')
        c = Math.round(credited * (plan.rate ?? 0));
    else {
        let prev = 0;
        for (const t of plan.tiers || []) {
            const top = t.upTo ?? Infinity;
            if (credited > prev)
                c += Math.round((Math.min(credited, top) - prev) * t.rate);
            if (credited <= top)
                break;
            prev = top;
        }
    }
    return plan.capCents != null ? Math.min(c, plan.capCents) : c;
}
/** Recoverable draw: the draw is paid every period; commission is netted against draw plus any carried shortfall. */
function applyDraw(earned, draw, shortfallIn) {
    const need = draw + shortfallIn;
    return { drawPaid: draw, extraPaid: Math.max(0, earned - need), shortfallOut: Math.max(0, need - earned) };
}
/** Negative commission line when a sale is refunded after payout (P9). */
function clawbackLine(paidCommission, saleCents, refundCents) {
    if (saleCents <= 0 || paidCommission <= 0)
        return 0;
    return -Math.round(paidCommission * Math.min(refundCents, saleCents) / saleCents);
}
/** P10: extra overtime premium owed because commission and non-discretionary bonus belong in the regular rate. */
function otPremiumOnExtras(extrasCents, totalHours, otHours) {
    if (totalHours <= 0 || otHours <= 0)
        return 0;
    return Math.round(0.5 * (extrasCents / totalHours) * otHours);
}
const MILLION = 100_000_000;
/** P18: flat federal supplemental withholding. 22% up to $1M in the year, 37% above. States set their own rates. */
function supplementalWithholding(bonus, ytdSupplemental) {
    const room = Math.max(0, MILLION - ytdSupplemental), low = Math.min(bonus, room);
    return Math.round(low * 0.22) + Math.round((bonus - low) * 0.37);
}
/** P18: may a paid bonus be recovered? Needs a signed agreement and to be inside the clawback window. */
function clawbackDecision(a) {
    if (!a.agreementOnFile)
        return { allowed: false, method: null, reason: 'No signed clawback agreement on file' };
    if (a.monthsSincePaid > a.windowMonths)
        return { allowed: false, method: null, reason: 'Outside the clawback window' };
    return { allowed: true, method: a.stateRestrictsDeduction ? 'invoice' : 'payroll_deduction', reason: a.stateRestrictsDeduction ? 'State limits wage deductions: collect by invoice' : 'Agreement on file' };
}
// P17: annual exempt salary floors in cents (Appendix A4, 2026). Alaska has conflicting sources: verify.
const FLOOR = { US: 3_556_800, CA: 7_030_400, WA: 8_016_840, NY: 6_235_320, NYC: 6_630_000, CO: 5_778_396, ME: 4_530_032 };
exports.VERIFY_FLOOR_STATES = ['AK'];
function exemptFloor(state, nycArea = false) {
    const st = (state || '').toUpperCase();
    return Math.max(FLOOR.US, st === 'NY' && nycArea ? FLOOR.NYC : FLOOR[st] || 0);
}
function checkPay(a) {
    const errors = [], warnings = [];
    if (a.exempt && a.annualCents < exemptFloor(a.state, a.nycArea))
        errors.push(`Exempt salary is below the ${a.state.toUpperCase()} floor of $${(exemptFloor(a.state, a.nycArea) / 100).toLocaleString('en-US')}`);
    if (a.exempt && exports.VERIFY_FLOOR_STATES.includes(a.state.toUpperCase()))
        warnings.push('Alaska exempt salary floor: sources conflict, verify with the state labor department');
    if (a.band && (a.annualCents < a.band.min || a.annualCents > a.band.max))
        warnings.push('Outside the pay band: needs HR approval');
    return { ok: errors.length === 0, errors, warnings };
}
