import { describe, it, expect } from 'vitest';
import * as R from '../src/recruitmentCore';

describe('S8 restricted questions', () => {
  it.each(['Are you married?', 'What is your date of birth?', 'Do you have any disabilities?', 'Are you a US citizen?', 'What is your current salary?', 'Please upload a photo of yourself', 'Do you plan to have children?', 'What religion are you?'])('blocks "%s"', (q) => expect(R.checkQuestion(q)).toBeTruthy());
  it.each(['Describe a project where you led a team of engineers.', 'Are you legally authorized to work in the United States?', 'Can you perform the essential functions of this job with or without accommodation?', 'Do you hold a valid RN license?'])('allows "%s"', (q) => expect(R.checkQuestion(q)).toBeNull());
  it('rejects empty and overlong questions', () => { expect(R.checkQuestion('hi')).toBeTruthy(); expect(R.checkQuestion('x'.repeat(301))).toBeTruthy(); });
});
describe('stage flow', () => {
  it('allows the normal path and blocks shortcuts', () => {
    expect(R.canMove('received', 'screening')).toBe(true); expect(R.canMove('screening', 'interview')).toBe(true); expect(R.canMove('interview', 'offer')).toBe(true);
    expect(R.canMove('received', 'offer')).toBe(false); expect(R.canMove('screening', 'offer')).toBe(false); expect(R.canMove('interview', 'hired')).toBe(false); expect(R.canMove('offer', 'hired')).toBe(false);
    expect(R.canMove('rejected', 'screening')).toBe(false); expect(R.canMove('hired', 'rejected')).toBe(false); expect(R.canMove('talent_pool', 'screening')).toBe(true);
  });
});
describe('rubric score', () => {
  const c = R.DEFAULT_CRITERIA;
  it('maps 1..5 to 0..100 with weights', () => {
    expect(R.weightedScore(c, { skills: 5, experience: 5, credentials: 5, availability: 5 })).toBe(100);
    expect(R.weightedScore(c, { skills: 1, experience: 1, credentials: 1, availability: 1 })).toBe(0);
    expect(R.weightedScore(c, { skills: 5, experience: 1, credentials: 1, availability: 1 })).toBe(40);
  });
  it('requires every criterion, integers 1-5 (same rubric for everyone)', () => {
    expect(() => R.weightedScore(c, { skills: 5 })).toThrow(); expect(() => R.weightedScore(c, { skills: 6, experience: 3, credentials: 3, availability: 3 })).toThrow(); expect(() => R.weightedScore(c, { skills: 2.5, experience: 3, credentials: 3, availability: 3 })).toThrow();
  });
});
describe('work history discrepancy', () => {
  it('cannot reject until every discrepancy has the candidate\u2019s clarification', () => {
    expect(R.canRejectForDiscrepancy([{ employer: 'A', title: 'x', status: 'verified' }])).toBe(false);
    expect(R.canRejectForDiscrepancy([{ employer: 'A', title: 'x', status: 'discrepancy' }])).toBe(false);
    expect(R.canRejectForDiscrepancy([{ employer: 'A', title: 'x', status: 'discrepancy', clarification: 'Company renamed in 2021' }])).toBe(true);
  });
});
describe('interview readiness', () => {
  it('needs a scorecard and not a unanimous no', () => {
    expect(R.interviewReadiness([]).ok).toBe(false); expect(R.interviewReadiness([{ recommendation: 'no' }, { recommendation: 'strong_no' }]).ok).toBe(false);
    expect(R.interviewReadiness([{ recommendation: 'no' }, { recommendation: 'yes' }]).ok).toBe(true);
  });
});
describe('FCRA state machine', () => {
  const at = (d: string) => new Date(d + 'T12:00:00Z');
  it('business days skip weekends', () => { expect(R.businessDaysBetween(at('2026-11-13'), at('2026-11-16'))).toBe(1); expect(R.businessDaysBetween(at('2026-11-16'), at('2026-11-23'))).toBe(5); });
  it('enforces order', () => {
    expect(R.bgTransition('none', 'record_report', null, new Date())).toHaveProperty('error'); expect(R.bgTransition('none', 'send_disclosure', null, new Date())).toEqual({ to: 'disclosure_sent' });
    expect(R.bgTransition('authorized', 'record_report', null, new Date())).toEqual({ to: 'report_received' }); expect(R.bgTransition('report_received', 'final_adverse', null, new Date())).toHaveProperty('error');
  });
  it('final adverse notice needs the 5 business day wait after pre-adverse', () => {
    expect(R.bgTransition('pre_adverse', 'final_adverse', at('2026-11-16'), at('2026-11-20'))).toHaveProperty('error');
    expect(R.bgTransition('pre_adverse', 'final_adverse', at('2026-11-16'), at('2026-11-23'))).toEqual({ to: 'adverse' });
  });
});
describe('pay range and templates', () => {
  it('pay range states', () => { expect(R.payRangeRequired('ca')).toBe(true); expect(R.payRangeRequired('TX')).toBe(false); });
  it('renders messages without leaking undefined', () => {
    const t = R.template('interview_invite', { name: 'Hina', role: 'QA', when: 'Mon 10:00', format: 'video', company: 'AMS' }); expect(t.subject).toContain('QA'); expect(t.body).not.toContain('undefined'); expect(t.body).toContain('accommodation');
    expect(R.template('rejection', { name: 'Hina', role: 'QA' }).body).not.toMatch(/future consideration/i); expect(R.payText({ payType: 'salary', rate: 85000 })).toBe('$85,000 per year (salary)');
  });
});
