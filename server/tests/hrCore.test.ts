import { describe, it, expect } from 'vitest';
import * as H from '../src/hrCore';
describe('part-time (P19)', () => {
  it('30 hour average triggers ACA and reclassification', () => { const r = H.partTimeStatus({ type: 'part_time', hours12m: 1600, monthsService: 14, hoursYear1: 600, hoursYear2: 700 }); expect(r.aca).toBe(true); expect(r.reclassify).toBe(true); expect(r.fmla).toBe(true); expect(r.ltpt401k).toBe(true); });
  it('20 hours a week is none of them', () => { const r = H.partTimeStatus({ type: 'part_time', hours12m: 1040, monthsService: 6, hoursYear1: 400, hoursYear2: 0 }); expect([r.aca, r.fmla, r.ltpt401k, r.reclassify]).toEqual([false, false, false, false]); });
  it('FMLA needs 12 months and 1250 hours', () => { expect(H.partTimeStatus({ type: 'part_time', hours12m: 1300, monthsService: 11, hoursYear1: 0, hoursYear2: 0 }).fmla).toBe(false); expect(H.partTimeStatus({ type: 'part_time', hours12m: 1249, monthsService: 24, hoursYear1: 0, hoursYear2: 0 }).fmla).toBe(false); });
  it('predictive scheduling cities', () => { expect(H.noticeDays('Seattle')).toBe(14); expect(H.noticeDays('Dallas')).toBe(0); });
});
describe('unemployment evidence (P20/P21/S7)', () => {
  it('layoff usually eligible, employer cause', () => { const e = H.uiEvidence('layoff'); expect(e.indicator).toBe('usually_eligible'); expect(e.whoseCause).toBe('employer'); });
  it('misconduct and quit without cause usually disqualified', () => { expect(H.uiEvidence('misconduct').indicator).toBe('usually_disqualified'); expect(H.uiEvidence('quit_no_cause').indicator).toBe('usually_disqualified'); });
  it('poor performance is not misconduct', () => expect(H.uiEvidence('performance').indicator).toBe('usually_eligible'));
  it('attendance and personal good cause depend on the state', () => { expect(H.uiEvidence('attendance').indicator).toBe('depends'); expect(H.uiEvidence('quit_good_cause_personal').indicator).toBe('depends'); });
  it('always says the agency decides; unknown reason throws', () => { expect(H.uiEvidence('layoff').notice).toContain('agency decides'); expect(() => H.uiEvidence('nonsense')).toThrow(); });
  it('response due date', () => { expect(H.uiResponseDue('2026-11-20')).toBe('2026-11-30'); expect(H.uiResponseDue('2026-12-28', 7)).toBe('2027-01-04'); });
});
describe('warnings (S5)', () => {
  it('ladder', () => { expect(H.nextWarningLevel([])).toBe('first_written'); expect(H.nextWarningLevel(['first_written'])).toBe('second'); expect(H.nextWarningLevel(['first_written', 'second', 'final'])).toBeNull(); });
  it('needs all five fields', () => { expect(H.validateWarning({}).length).toBe(5); expect(H.validateWarning({ issue: 'a', standard: 'b', support: 'c', timeline: 'd', consequences: 'e' })).toEqual([]); });
  it('termination needs final warning, final review and HR/legal review', () => { const base = { issued: ['first_written', 'second', 'final'] as any, finalReviewDone: true, hrLegalReviewed: true }; expect(H.mayConsiderTermination(base)).toBe(true); expect(H.mayConsiderTermination({ ...base, hrLegalReviewed: false })).toBe(false); expect(H.mayConsiderTermination({ ...base, issued: ['first_written'] })).toBe(false); });
});
describe('training, rules, insurance, catalog', () => {
  it('training status', () => { const b = { dueDate: '2026-11-20', today: '2026-11-18' }; expect(H.trainingStatus(b)).toBe('assigned'); expect(H.trainingStatus({ ...b, startedAt: 'x' })).toBe('in_progress'); expect(H.trainingStatus({ ...b, today: '2026-11-21' })).toBe('overdue'); expect(H.trainingStatus({ ...b, today: '2026-11-21', completedAt: 'x' })).toBe('completed'); });
  const rules: H.Rule[] = [{ key: 'sick.wait', jurisdiction: 'US', effectiveDate: '2020-01-01', version: 1, value: 90 }, { key: 'sick.wait', jurisdiction: 'CA', effectiveDate: '2024-01-01', version: 2, value: 30 }, { key: 'sick.wait', jurisdiction: 'CA', effectiveDate: '2026-06-01', version: 3, value: 0 }, { key: 'sick.wait', jurisdiction: 'Seattle', effectiveDate: '2025-01-01', version: 1, value: 5 }];
  it('versioned rule: effective date decides', () => { expect(H.ruleAt(rules, 'sick.wait', ['CA', 'US'], '2025-01-01')?.value).toBe(30); expect(H.ruleAt(rules, 'sick.wait', ['CA', 'US'], '2026-11-18')?.value).toBe(0); });
  it('city beats state beats US; unknown key is null', () => { expect(H.ruleAt(rules, 'sick.wait', ['Seattle', 'WA', 'US'], '2026-01-01')?.value).toBe(5); expect(H.ruleAt(rules, 'sick.wait', ['TX', 'US'], '2026-01-01')?.value).toBe(90); expect(H.ruleAt(rules, 'nope', ['US'], '2026-01-01')).toBeNull(); expect(H.ruleAt(rules, 'sick.wait', ['CA'], '2023-01-01')).toBeNull(); });
  it('renewal buckets', () => { const t = '2026-11-18'; expect(H.renewalBucket('2026-11-17', t)).toBe('expired'); expect(H.renewalBucket('2026-11-25', t)).toBe('d7'); expect(H.renewalBucket('2026-12-18', t)).toBe('d30'); expect(H.renewalBucket('2027-03-01', t)).toBe('ok'); });
  it('15 insurance policies and 60 distinct benefits', () => { expect(H.INSURANCE.length).toBe(15); expect(H.BENEFITS.length).toBe(60); expect(new Set(H.BENEFITS).size).toBe(60); });
});
