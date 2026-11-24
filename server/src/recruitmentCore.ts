/**
 * Recruitment rules for P6 and S1-S3 / S8. Pure functions: no database, no clock (callers pass dates).
 * Legal values are baseline guidance (EEOC / FCRA / pay transparency, see Appendix A4 and S8). They are
 * defaults for HR to review, not legal advice.
 */

export const STAGES = ['received', 'screening', 'interview', 'offer', 'hired', 'rejected', 'talent_pool'] as const;
export type Stage = (typeof STAGES)[number];

/** Allowed stage moves. 'hired' is reached only through an accepted offer, never by a manual move. */
const FLOW: Record<Stage, Stage[]> = {
  received: ['screening', 'rejected'],
  screening: ['interview', 'talent_pool', 'rejected'],
  interview: ['offer', 'talent_pool', 'rejected'],
  offer: ['interview', 'rejected'],          // 'hired' only via offer acceptance; back to interview if the offer is withdrawn
  talent_pool: ['screening', 'rejected'],
  hired: [],
  rejected: [],
};
export const canMove = (from: Stage, to: Stage) => (FLOW[from] || []).includes(to);

export const REJECT_REASONS: Record<string, string> = {
  not_qualified: 'Does not meet the minimum qualifications',
  better_fit: 'Another candidate was a stronger fit',
  skills_gap: 'Skills gap against the job criteria',
  verification_discrepancy: 'Work history could not be confirmed after the candidate was asked to clarify',
  background_result: 'Background check result (after FCRA adverse action steps)',
  no_response: 'Candidate did not respond',
  withdrew: 'Candidate withdrew',
  position_closed: 'Position closed or filled',
  offer_declined: 'Offer declined',
};

/** States that require a pay range in job postings (Appendix A4, verify dates and employer size). */
export const PAY_RANGE_STATES = new Set(['CA', 'CO', 'CT', 'DC', 'HI', 'IL', 'MD', 'MA', 'MN', 'NV', 'NJ', 'NY', 'RI', 'VT', 'WA']);
export const payRangeRequired = (state: string) => PAY_RANGE_STATES.has((state || '').toUpperCase());

/** S8 restricted question library: screening questions must be job-related. */
const RESTRICTED: [RegExp, string][] = [
  [/\b(age|how old|date of birth|birth ?date|dob|year of birth|graduat\w* (year|date))\b/i, 'age'],
  [/\b(race|ethnic\w*|color|skin)\b/i, 'race or color'],
  [/\b(religio\w*|church|faith|pray\w*)\b/i, 'religion'],
  [/\b(married|marital|single|divorced|spouse|husband|wife|children|kids|pregnan\w*|family plans|plan to have)\b/i, 'family status or pregnancy'],
  [/\b(national origin|where (are|were) you born|native language|accent)\b/i, 'national origin'],
  [/\b(us citizen|u\.s\. citizen|american citizen|citizenship)\b/i, 'citizenship (ask about work authorization instead)'],
  [/\b(disab\w*|medical|illness|health condition|medication|sick days|mental health|genetic\w*)\b/i, 'disability, medical or genetic information'],
  [/\b(photo|picture|headshot)\b/i, 'applicant photo'],
  [/\b(arrest\w*|convict\w*|criminal|salary history|current salary|previous salary|how much (do|did) you (make|earn))\b/i, 'criminal or salary history (restricted in many states, needs legal review)'],
];
export function checkQuestion(text: string): string | null {
  const t = String(text || '').trim();
  if (t.length < 5) return 'Question is too short';
  if (t.length > 300) return 'Question is too long (300 characters maximum)';
  for (const [re, topic] of RESTRICTED) if (re.test(t)) return `Not allowed before an offer: it asks about ${topic}. Ask only job-related questions.`;
  return null;
}

export const DEFAULT_CRITERIA = [
  { key: 'skills', label: 'Skills for the role', weight: 40 },
  { key: 'experience', label: 'Relevant experience', weight: 30 },
  { key: 'credentials', label: 'Education, licenses, certifications', weight: 15 },
  { key: 'availability', label: 'Availability and schedule fit', weight: 15 },
];
export interface Criterion { key: string; label: string; weight: number }
/** Weighted rubric score from 1-5 ratings to 0-100. Every criterion must be rated (same rubric for everyone). */
export function weightedScore(criteria: Criterion[], ratings: Record<string, any>): number {
  let total = 0, wsum = 0;
  for (const c of criteria) {
    const v = Number(ratings?.[c.key]);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`Rate "${c.label}" from 1 to 5`);
    total += ((v - 1) / 4) * c.weight; wsum += c.weight;
  }
  return wsum ? Math.round((total / wsum) * 1000) / 10 : 0;
}

export interface HistoryItem { employer: string; title: string; start?: string; end?: string; status?: 'unverified' | 'verified' | 'discrepancy'; note?: string; clarification?: string }
/** S2: do not reject on an unexplained discrepancy. The candidate must have been asked, and the answer recorded. */
export const canRejectForDiscrepancy = (h: HistoryItem[]) => {
  const bad = (h || []).filter((x) => x.status === 'discrepancy');
  return bad.length > 0 && bad.every((x) => String(x.clarification || '').trim().length >= 3);
};

export const REC = { strong_yes: 2, yes: 1, no: -1, strong_no: -2 } as Record<string, number>;
/** Offer gate: at least one scorecard, and the panel must not be unanimously negative. */
export function interviewReadiness(cards: { recommendation: string }[]): { ok: boolean; reason?: string } {
  if (!cards.length) return { ok: false, reason: 'No interview scorecards yet. At least one is needed before an offer.' };
  if (cards.every((c) => (REC[c.recommendation] ?? 0) < 0)) return { ok: false, reason: 'Every interviewer recommended against this candidate.' };
  return { ok: true };
}
export const panelSummary = (cards: { recommendation: string; total: number }[]) => cards.length
  ? { count: cards.length, avg: Math.round((cards.reduce((a, c) => a + Number(c.total), 0) / cards.length) * 10) / 10,
      mood: cards.reduce((a, c) => a + (REC[c.recommendation] ?? 0), 0) / cards.length } : { count: 0, avg: 0, mood: 0 };

// ---- FCRA background check state machine (S2) ----
export type BgStatus = 'none' | 'disclosure_sent' | 'authorized' | 'report_received' | 'pre_adverse' | 'adverse' | 'cleared';
export const BG_WAIT_BUSINESS_DAYS = 5;   // common practice before the final adverse action notice; HR can configure
export function businessDaysBetween(from: Date, to: Date): number {
  let n = 0; const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() < end) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
const BG: Record<string, { from: BgStatus[]; to: BgStatus }> = {
  send_disclosure: { from: ['none'], to: 'disclosure_sent' },
  record_authorization: { from: ['disclosure_sent'], to: 'authorized' },
  record_report: { from: ['authorized'], to: 'report_received' },
  clear: { from: ['report_received', 'pre_adverse'], to: 'cleared' },
  pre_adverse: { from: ['report_received'], to: 'pre_adverse' },
  final_adverse: { from: ['pre_adverse'], to: 'adverse' },
};
export function bgTransition(status: BgStatus, action: string, preAdverseAt: Date | null, now: Date): { to: BgStatus } | { error: string } {
  const t = BG[action]; if (!t) return { error: 'Unknown background check action' };
  if (!t.from.includes(status)) return { error: `Cannot do "${action.replace('_', ' ')}" while the check is "${status.replace('_', ' ')}"` };
  if (action === 'final_adverse') {
    const waited = preAdverseAt ? businessDaysBetween(preAdverseAt, now) : 0;
    if (waited < BG_WAIT_BUSINESS_DAYS) return { error: `FCRA waiting period: ${BG_WAIT_BUSINESS_DAYS} business days must pass after the pre-adverse notice (${waited} so far). The candidate must be able to dispute the report.` };
  }
  return { to: t.to };
}

// ---- Candidate communications (S3 templates) ----
export type MsgKind = 'application_received' | 'interview_invite' | 'rejection' | 'offer' | 'background_disclosure' | 'pre_adverse' | 'final_adverse' | 'welcome';
export function template(kind: MsgKind, v: Record<string, any>): { subject: string; body: string } {
  const co = v.company || 'our company', name = v.name || 'there', role = v.role || 'the role', sign = `${v.sender || 'Talent Team'}\n${co}`;
  switch (kind) {
    case 'application_received': return { subject: `We received your application for ${role}`, body: `Hello ${name},\n\nThank you for applying for ${role} at ${co}. We have received your application and will review it against the job requirements. If you need an accommodation during the process, contact ${v.accommodation || 'our HR team'}.\n\n${sign}` };
    case 'interview_invite': return { subject: `Interview invitation: ${role}`, body: `Hello ${name},\n\nThank you for your interest in ${role}. We would like to invite you to an interview.\n\nWhen: ${v.when} (${v.tz || 'local time'})\nFormat: ${v.format}${v.where ? `\nWhere: ${v.where}` : ''}\nPanel: ${v.panel || 'to be confirmed'}\n\nPlease confirm by replying to this message. If you need a reasonable accommodation, contact ${v.accommodation || 'our HR team'}.\n\n${sign}` };
    case 'rejection': return { subject: `Your application for ${role}`, body: `Hello ${name},\n\nThank you for the time you put into applying for ${role} at ${co}. After careful review we have decided not to move forward with your application.\n\nWe appreciate your interest and wish you well in your search.\n\n${sign}` };
    case 'offer': return { subject: `Offer of employment: ${role}`, body: `Hello ${name},\n\nWe are pleased to offer you the position of ${v.title || role} at ${co}.\n\nPay: ${v.pay}\nStart date: ${v.startDate}\nWork location: ${v.location}\nReports to: ${v.manager || 'your hiring manager'}\n${v.contingencies ? `\nThis offer is contingent on: ${v.contingencies}\n` : ''}\nPlease respond by ${v.deadline}.\n\n${sign}` };
    case 'background_disclosure': return { subject: 'Background check disclosure and authorization', body: `Hello ${name},\n\n${co} may obtain a consumer report about you for employment purposes. This notice is separate from your application. Please read the attached disclosure and, if you agree, return the signed authorization. We will not order a report without it.\n\n${sign}` };
    case 'pre_adverse': return { subject: 'Notice before a possible adverse decision', body: `Hello ${name},\n\nWe may decide not to move forward based in whole or in part on information in a consumer report. A copy of the report and the summary of your rights under the Fair Credit Reporting Act are attached. You have ${BG_WAIT_BUSINESS_DAYS} business days to tell us if any information is inaccurate or to give us more context before we decide.\n\n${sign}` };
    case 'final_adverse': return { subject: `Decision on your application for ${role}`, body: `Hello ${name},\n\nAfter the review period we have decided not to move forward with your application, based in whole or in part on a consumer report. The reporting agency did not make this decision and cannot explain it. You have the right to a free copy of the report within 60 days and to dispute its accuracy with the agency.\n\n${sign}` };
    case 'welcome': return { subject: `Welcome to ${co}`, body: `Hello ${name},\n\nThank you for accepting. Your onboarding checklist is ready: sign in with the details HR sent you and complete your I-9 Section 1, W-4 and policy sign-offs before your first day.\n\n${sign}` };
  }
}

export const money = (n: number) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
export const payText = (o: { payType: string; rate: number | string }) => o.payType === 'salary' ? `${money(+o.rate)} per year (salary)` : `${money(+o.rate)} per hour`;
