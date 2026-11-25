"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.finalPay = finalPay;
function finalPay(i) {
    const review = [], hourly = i.payType !== 'salary' && i.hourlyRateCents > 0;
    const wages = hourly ? Math.round(i.unpaid.regularHours * i.hourlyRateCents + i.unpaid.otHours * i.hourlyRateCents * 1.5 + i.unpaid.dtHours * i.hourlyRateCents * 2) : 0;
    if (!hourly)
        review.push('Salaried employee: pro-rate the final salary period under the work state rules');
    if (!i.rule)
        review.push(`No final-pay rule is configured for ${i.state || 'this work state'}. Add one in Compliance rules or escalate to HR / payroll counsel`);
    else if (!i.rule.verified)
        review.push(`The ${i.state} final-pay rule has not been verified by counsel`);
    let leave = 0;
    if (i.rule && hourly)
        leave = Math.round(((i.rule.payoutAccruedLeave ? i.leave.annualHours : 0) + (i.rule.payoutSick ? i.leave.sickHours : 0)) * i.hourlyRateCents);
    if (i.rule && !hourly && (i.rule.payoutAccruedLeave || i.rule.payoutSick) && (i.leave.annualHours > 0 || i.leave.sickHours > 0))
        review.push('Accrued leave must be paid out under this rule: calculate it from the salary rate');
    if (i.pendingBonusCents > 0)
        review.push('Approved bonuses are not paid yet: some states treat earned bonuses as wages due on final pay, others follow the written plan');
    if (i.pendingCommissionCents !== 0)
        review.push('Approved commission lines are not paid yet: include them in the final pay sheet');
    return { wagesCents: wages, leavePayoutCents: leave, pendingBonusCents: i.pendingBonusCents, pendingCommissionCents: i.pendingCommissionCents, subtotalCents: wages + leave, deadline: i.rule?.deadline ?? null, needsReview: review };
}
