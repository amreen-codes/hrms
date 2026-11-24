import { describe, it, expect } from 'vitest';
import * as P from '../src/payCore';

const tiers: P.Plan = { kind: 'tiered', tiers: [{ upTo: 10_000_00, rate: 0.05 }, { upTo: 50_000_00, rate: 0.08 }, { upTo: null, rate: 0.1 }] };
describe('commission plan (P9)', () => {
  it('rejects NaN rates (blank form field)', () => { expect(P.validatePlan({ kind: 'flat', rate: NaN }).length).toBe(1); expect(P.validatePlan({ kind: 'tiered', tiers: [{ upTo: null, rate: NaN }] }).length).toBe(1); });
  it('flat rate', () => expect(P.commissionFor(20_000_00, { kind: 'flat', rate: 0.05 })).toBe(1_000_00));
  it('marginal tiers', () => { // 10k*5% + 40k*8% + 10k*10% = 500 + 3200 + 1000
    expect(P.commissionFor(60_000_00, tiers)).toBe(4_700_00); expect(P.commissionFor(10_000_00, tiers)).toBe(500_00); expect(P.commissionFor(0, tiers)).toBe(0); });
  it('cap applies last', () => expect(P.commissionFor(60_000_00, { ...tiers, capCents: 2_000_00 })).toBe(2_000_00));
  it('split credit', () => expect(P.creditedSales([{ amountCents: 10_000_00, splitPct: 50 }, { amountCents: 1_000_00 }])).toBe(6_000_00));
  it('validates plans', () => {
    expect(P.validatePlan(tiers)).toEqual([]);
    expect(P.validatePlan({ kind: 'flat', rate: 1.5 }).length).toBe(1);
    expect(P.validatePlan({ kind: 'tiered', tiers: [{ upTo: 100, rate: 0.1 }] })).toContain('The last tier must be open-ended');
    expect(P.validatePlan({ kind: 'tiered', tiers: [{ upTo: 100, rate: 0.1 }, { upTo: 50, rate: 0.1 }, { upTo: null, rate: 0.1 }] }).length).toBe(1);
  });
});
describe('draw and clawback (P9)', () => {
  it('earned below draw carries shortfall', () => expect(P.applyDraw(800_00, 1_000_00, 0)).toEqual({ drawPaid: 1_000_00, extraPaid: 0, shortfallOut: 200_00 }));
  it('later period repays carried shortfall first', () => expect(P.applyDraw(1_500_00, 1_000_00, 200_00)).toEqual({ drawPaid: 1_000_00, extraPaid: 300_00, shortfallOut: 0 }));
  it('refund creates a proportional negative line', () => { expect(P.clawbackLine(500_00, 10_000_00, 10_000_00)).toBe(-500_00); expect(P.clawbackLine(500_00, 10_000_00, 2_000_00)).toBe(-100_00); });
  it('refund above the sale is capped', () => expect(P.clawbackLine(500_00, 10_000_00, 99_999_00)).toBe(-500_00));
});
describe('OT regular rate with extras (P10)', () => {
  it('adds half-time on commission and bonus', () => expect(P.otPremiumOnExtras(800_00, 50, 10)).toBe(80_00)); // 800/50=16/h, half=8, x10
  it('no hours means no premium', () => { expect(P.otPremiumOnExtras(800_00, 0, 10)).toBe(0); expect(P.otPremiumOnExtras(800_00, 40, 0)).toBe(0); });
});
describe('bonus (P18)', () => {
  it('22% flat under $1M', () => expect(P.supplementalWithholding(5_000_00, 0)).toBe(1_100_00));
  it('37% on the part above $1M', () => expect(P.supplementalWithholding(200_000_00, 999_000_00 * 1)).toBe(Math.round(1_000_00 * 0.22) + Math.round(199_000_00 * 0.37)));
  it('clawback needs an agreement', () => expect(P.clawbackDecision({ agreementOnFile: false, monthsSincePaid: 1, windowMonths: 12, stateRestrictsDeduction: false }).allowed).toBe(false));
  it('clawback window', () => expect(P.clawbackDecision({ agreementOnFile: true, monthsSincePaid: 13, windowMonths: 12, stateRestrictsDeduction: false }).reason).toBe('Outside the clawback window'));
  it('restricted state means invoice, not payroll deduction', () => expect(P.clawbackDecision({ agreementOnFile: true, monthsSincePaid: 3, windowMonths: 12, stateRestrictsDeduction: true }).method).toBe('invoice'));
  it('allowed by payroll deduction otherwise', () => expect(P.clawbackDecision({ agreementOnFile: true, monthsSincePaid: 3, windowMonths: 12, stateRestrictsDeduction: false }).method).toBe('payroll_deduction'));
});
describe('pay checks (P17)', () => {
  it('uses the higher of federal and state floor', () => { expect(P.exemptFloor('TX')).toBe(3_556_800); expect(P.exemptFloor('CA')).toBe(7_030_400); expect(P.exemptFloor('ny', true)).toBe(6_630_000); });
  it('rejects exempt pay under the floor', () => { const r = P.checkPay({ exempt: true, annualCents: 60_000_00, state: 'CA' }); expect(r.ok).toBe(false); expect(r.errors.length).toBe(1); });
  it('non-exempt has no salary floor', () => expect(P.checkPay({ exempt: false, annualCents: 20_000_00, state: 'CA' }).ok).toBe(true));
  it('flags Alaska and out-of-band pay as warnings', () => { const r = P.checkPay({ exempt: true, annualCents: 90_000_00, state: 'AK', band: { min: 50_000_00, max: 80_000_00 } }); expect(r.ok).toBe(true); expect(r.warnings.length).toBe(2); });
});
