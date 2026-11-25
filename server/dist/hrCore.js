"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BENEFITS = exports.INSURANCE = exports.renewalBucket = exports.trainingStatus = exports.mayConsiderTermination = exports.nextWarningLevel = exports.uiResponseDue = exports.UI_REASONS = exports.noticeDays = void 0;
exports.partTimeStatus = partTimeStatus;
exports.uiEvidence = uiEvidence;
exports.validateWarning = validateWarning;
exports.ruleAt = ruleAt;
/** Pure rules for P19 part-time, P20/P21/S7 unemployment evidence, S4 training, S5 warnings, S8 versioned rules, A8 insurance, A9 catalog. Defaults for HR to review, not legal advice. */
function partTimeStatus(a) {
    const avgWeekly = a.hours12m / 52, aca = avgWeekly >= 30;
    return { avgWeekly: Math.round(avgWeekly * 10) / 10, aca, fmla: a.monthsService >= 12 && a.hours12m >= 1250, ltpt401k: a.hoursYear1 >= 500 && a.hoursYear2 >= 500, reclassify: a.type === 'part_time' && aca };
}
const PREDICTIVE = ['new york city', 'nyc', 'chicago', 'seattle', 'san francisco', 'philadelphia', 'los angeles', 'oregon', 'or'];
/** Advance schedule notice in days. 14 is a common baseline; the real figure varies by law (A5: verify). */
const noticeDays = (cityOrState) => (PREDICTIVE.includes((cityOrState || '').trim().toLowerCase()) ? 14 : 0);
exports.noticeDays = noticeDays;
const UI = {
    layoff: ['usually_eligible', 'employer', 'separation date and reason'], business_closing: ['usually_eligible', 'employer', 'separation date and reason'], contract_ended: ['usually_eligible', 'neither', 'contract and end date'],
    hours_cut: ['usually_eligible', 'employer', 'pay and hours history'], performance: ['usually_eligible', 'mixed', 'performance reviews'], honest_mistake: ['usually_eligible', 'mixed', 'incident notes'],
    quit_good_cause_work: ['usually_eligible', 'employer', 'complaint records'], quit_good_cause_personal: ['depends', 'neither', 'state rule on personal good cause'],
    misconduct: ['usually_disqualified', 'employee', 'signed policy, incident report, witness notes'], attendance: ['depends', 'employee', 'attendance log, written warnings, last incident date'],
    quit_no_cause: ['usually_disqualified', 'employee', 'resignation letter, exit notes'], abandonment: ['usually_disqualified', 'employee', 'contact attempts and dates'],
    quit_to_avoid_firing: ['depends', 'mixed', 'termination notice or warnings'], fraud: ['usually_disqualified', 'employee', 'accurate claim responses']
};
exports.UI_REASONS = Object.keys(UI);
/** Evidence summary only. The state agency decides: never store this as the claim result. */
function uiEvidence(r) { const x = UI[r]; if (!x)
    throw new Error('Unknown separation reason'); return { indicator: x[0], whoseCause: x[1], keep: x[2], notice: 'Guidance only. The state UI agency decides eligibility.' }; }
const uiResponseDue = (noticeDate, days = 10) => new Date(new Date(noticeDate + 'T00:00:00Z').getTime() + days * 864e5).toISOString().slice(0, 10);
exports.uiResponseDue = uiResponseDue;
const LADDER = ['first_written', 'second', 'final'];
const nextWarningLevel = (issued) => LADDER[issued.length] ?? null;
exports.nextWarningLevel = nextWarningLevel;
function validateWarning(w) {
    const miss = ['issue', 'standard', 'support', 'timeline', 'consequences'].filter((k) => !String(w[k] || '').trim());
    return miss.map((k) => `${k} is required (S5: specific issue, expected standard, support, timeline and consequences)`);
}
/** Termination after warnings needs the final level issued, the final review held and HR/legal review recorded. */
const mayConsiderTermination = (a) => a.issued.includes('final') && a.finalReviewDone && a.hrLegalReviewed;
exports.mayConsiderTermination = mayConsiderTermination;
const trainingStatus = (a) => a.completedAt ? 'completed' : a.today > a.dueDate ? 'overdue' : a.startedAt ? 'in_progress' : 'assigned';
exports.trainingStatus = trainingStatus;
/** S8: effective-dated, append-only rules. Most specific jurisdiction wins (city, then state, then US); latest version in force on the date. */
function ruleAt(rules, key, jurisdictions, date) {
    for (const j of jurisdictions) {
        const c = rules.filter((r) => r.key === key && r.jurisdiction.toLowerCase() === j.toLowerCase() && r.effectiveDate <= date).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.version - a.version);
        if (c.length)
            return c[0];
    }
    return null;
}
const renewalBucket = (expiry, today) => {
    const d = Math.floor((new Date(expiry).getTime() - new Date(today).getTime()) / 864e5);
    return d < 0 ? 'expired' : d <= 7 ? 'd7' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'ok';
};
exports.renewalBucket = renewalBucket;
exports.INSURANCE = ["Workers' Compensation", 'Unemployment Insurance', 'Employment Practices Liability (EPLI)', 'Commercial General Liability (CGL)', 'Key Person', 'Commercial Auto', 'Property', 'Cyber Liability', 'Directors & Officers (D&O)', 'Fiduciary Liability', 'Professional Liability / E&O', 'Employment-Related Practices Liability', 'Umbrella / Excess Liability', 'Business Interruption', 'Crime / Fidelity Bond'];
/** A9: the PDF numbers 75 benefits, but items 61-75 repeat items 46-60 (Relocation Assistance to Fertility Benefits). There are 60 distinct benefits. */
exports.BENEFITS = 'Medical Insurance|Dental Insurance|Vision Insurance|Life Insurance|Short-Term Disability Insurance|Long-Term Disability Insurance|Accident Insurance|Critical Illness Insurance|Cancer Insurance|401(k) / 403(b) Retirement Plan|Employer 401(k) Match|Pension Plan|Financial Planning Services|Vacation Days|Sick Leave|Paid Holidays|Parental Leave|Bereavement Leave|PTO Banks|Flexible Work Arrangements|Remote Work Stipends|Employee Assistance Programs (EAP)|Wellness Programs|Gym Memberships|Mental Health Support|Childcare Subsidies|On-Site Childcare|Dependent Care FSA|Elder Care Support|Tuition Reimbursement|Professional Memberships|Certification Reimbursement|Training & Upskilling Programs|Commuter Benefits|Pet Insurance|Legal Insurance|Identity Theft Protection|Long-Term Care Insurance|Health Savings Account (HSA)|Flexible Spending Account (FSA)|Employee Stock Ownership Plan (ESOP)|Stock Options|Profit Sharing|Bonuses|Commission|Relocation Assistance|Signing Bonuses|Referral Bonuses|Recognition Programs|Company Vehicle|Cell Phone Stipend|Internet Stipend|Meal Allowances|Travel Perks|Sabbatical Leave|Volunteer Time Off|Employee Discounts|Group Legal Plans|Adoption Assistance|Fertility Benefits'.split('|');
