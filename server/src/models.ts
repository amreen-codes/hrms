import 'dotenv/config';
import { Sequelize, DataTypes as T, Op } from 'sequelize';
import { currentCtx } from './tenancy';
export const sequelize = new Sequelize(process.env.DB_NAME || 'ams_hrms', process.env.DB_USER || 'root', process.env.DB_PASS || '', { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306, dialect: 'mysql', logging: false });
// ---------------------------------------------------------------- multi-tenancy (P14)
// Every model except Company gets a companyId. Hooks below filter every read/update/delete by the current company and stamp every insert.
const TENANTLESS = new Set(['Company', 'StripeEvent']);
const d = (n: string, f: any, o?: any) => sequelize.define(n, TENANTLESS.has(n) ? f : { ...f, companyId: { type: T.INTEGER, allowNull: true } },
  { ...o, indexes: [...(o?.indexes || []), ...(TENANTLESS.has(n) ? [] : [{ fields: ['companyId'] }])] });
const isTenant = (m: any) => !!m?.rawAttributes?.companyId;
const scopeOf = (): number | null => { const c = currentCtx(); if (!c || c.platform) return null; if (c.companyId == null) throw new Error('No company context for a tenant query'); return c.companyId; };
const and = (w: any, id: number) => ({ [Op.and]: [w || {}, { companyId: id }] });
// NOTE: Sequelize calls find/count/bulk hooks with the MODEL as `this` (options.model is not set), so these must be regular functions.
const modelOf = (self: any, o: any) => self?.rawAttributes ? self : o?.model;
sequelize.addHook('beforeFind', function (this: any, o: any) { const m = modelOf(this, o); if (!isTenant(m)) return; const id = scopeOf(); if (id === null) return; o.__origWhere = o.where; o.where = and(o.where, id); });
sequelize.addHook('beforeCount', function (this: any, o: any) { const m = modelOf(this, o); if (!isTenant(m)) return; const id = scopeOf(); if (id !== null) o.where = and(o.where, id); });
sequelize.addHook('beforeBulkUpdate', function (this: any, o: any) { const m = modelOf(this, o); if (!isTenant(m)) return; const id = scopeOf(); if (id !== null) o.where = and(o.where, id); });
sequelize.addHook('beforeBulkDestroy', function (this: any, o: any) { const m = modelOf(this, o); if (!isTenant(m)) return; const id = scopeOf(); if (id !== null) o.where = and(o.where, id); });
const stamp = (inst: any) => { if (!isTenant(inst.constructor)) return; const id = scopeOf(); if (id === null) return;
  if (inst.companyId == null) inst.companyId = id; else if (inst.companyId !== id) throw new Error('Cross-company write blocked'); };
sequelize.addHook('beforeCreate', (inst: any) => stamp(inst));
sequelize.addHook('beforeBulkCreate', (insts: any[]) => insts.forEach(stamp));
// "log cross-company attempts": a by-id lookup that finds nothing inside the company but exists in ANOTHER company is recorded.
sequelize.addHook('afterFind', async function (this: any, result: any, o: any) {
  try {
    const m = modelOf(this, o), c = currentCtx(); if (!c || c.platform || !c.companyId || !isTenant(m)) return;
    if (result && !(Array.isArray(result) && result.length === 0)) return;
    const id = o.__origWhere?.id; if (typeof id !== 'number' && typeof id !== 'string') return;
    const [rows]: any = await sequelize.query('SELECT companyId FROM `' + m.getTableName() + '` WHERE id = ? LIMIT 1', { replacements: [id] });
    if (rows[0] && rows[0].companyId !== c.companyId)
      await SecurityEvent.create({ type: 'cross_company_attempt', detail: `${m.name} #${id}`, companyId: c.companyId } as any);
  } catch { /* never block a request because the audit write failed */ }
});
export const SECRET_FIELDS = ['password', 'inviteTokenHash', 'inviteExpiresAt'];
// People (P5 onboarding, P8 offboarding, P19 part-time)
export const Employee = d('Employee', { name: T.STRING, email: { type: T.STRING, unique: true }, password: T.STRING,
  role: { type: T.ENUM('admin', 'hr', 'manager', 'employee', 'superadmin'), defaultValue: 'employee' }, department: T.STRING, title: T.STRING,
  workState: { type: T.STRING, defaultValue: 'TX' }, type: { type: T.ENUM('full_time', 'part_time'), defaultValue: 'full_time' },
  hourlyRate: { type: T.DECIMAL(10, 2), defaultValue: 0 }, phone: T.STRING, startDate: T.DATEONLY, annualSalary: { type: T.DECIMAL(12, 2), defaultValue: 0 }, payType: { type: T.ENUM('hourly', 'salary'), defaultValue: 'hourly' }, flsaExempt: { type: T.BOOLEAN, defaultValue: false }, profile: T.JSON, status: { type: T.ENUM('onboarding', 'active', 'terminated', 'invited'), defaultValue: 'active' }, managerId: T.INTEGER, failedAttempts: { type: T.INTEGER, defaultValue: 0 }, lockedUntil: T.DATE, accessRevokedAt: T.DATE, mustChangePassword: { type: T.BOOLEAN, defaultValue: false, allowNull: false },
  inviteTokenHash: T.STRING(64), inviteExpiresAt: T.DATE, passwordChangedAt: T.DATE }, { defaultScope: { attributes: { exclude: SECRET_FIELDS } } });
// P1 attendance + OT
export const Attendance = d('Attendance', { employeeId: T.INTEGER, date: T.DATEONLY, clockIn: T.DATE, clockOut: T.DATE,
  hours: { type: T.DECIMAL(5, 2), defaultValue: 0 }, status: { type: T.ENUM('present', 'absent', 'leave'), defaultValue: 'present' } });
// P2 leave with balance check (hours)
export const LeaveBalance = d('LeaveBalance', { employeeId: T.INTEGER, type: T.STRING, total: T.INTEGER, used: { type: T.INTEGER, defaultValue: 0 }, pending: { type: T.INTEGER, defaultValue: 0 } });
export const LeaveRequest = d('LeaveRequest', { employeeId: T.INTEGER, type: T.STRING, startDate: T.DATEONLY, endDate: T.DATEONLY, hours: T.INTEGER, reason: T.STRING,
  status: { type: T.ENUM('pending', 'approved', 'rejected'), defaultValue: 'pending' }, comment: T.STRING });
// P4 payroll
export const PaySheet = d('PaySheet', { employeeId: T.INTEGER, period: T.STRING, regularHours: { type: T.DECIMAL(8, 2), defaultValue: 0 }, otHours: { type: T.DECIMAL(8, 2), defaultValue: 0 },
  gross: { type: T.DECIMAL(10, 2), defaultValue: 0 }, commission: { type: T.DECIMAL(10, 2), defaultValue: 0 }, bonus: { type: T.DECIMAL(10, 2), defaultValue: 0 }, deductions: { type: T.DECIMAL(10, 2), defaultValue: 0 }, net: { type: T.DECIMAL(10, 2), defaultValue: 0 },
  status: { type: T.ENUM('draft', 'reviewed', 'approved', 'locked', 'exported'), defaultValue: 'draft' },
  version: { type: T.INTEGER, defaultValue: 1 }, adjustment: { type: T.DECIMAL(10, 2), defaultValue: 0 }, reviewedBy: T.INTEGER, approvedBy: T.INTEGER, approvedAt: T.DATE, lastAdjustedBy: T.INTEGER });
// P3 compliance, P6 ATS, audit
export const ComplianceTask = d('ComplianceTask', { employeeId: T.INTEGER, type: T.STRING, dueDate: T.DATEONLY, status: { type: T.ENUM('open', 'overdue', 'done', 'waived'), defaultValue: 'open' },
  ownerId: T.INTEGER, locationKey: T.STRING(30), ruleId: T.INTEGER, source: T.STRING(20), periodKey: T.STRING(20), overdueNotifiedAt: T.DATE, escalatedAt: T.DATE, escalationLevel: { type: T.INTEGER, defaultValue: 0 }, waivedBy: T.INTEGER, waiveReason: T.STRING(1000) });
export const STAGE_VALUES = ['received', 'screening', 'interview', 'offer', 'hired', 'rejected', 'talent_pool'];
export const Candidate = d('Candidate', { name: T.STRING, position: T.STRING, stage: { type: T.ENUM(...STAGE_VALUES), defaultValue: 'received' },
  email: T.STRING(160), phone: T.STRING(40), requisitionId: T.INTEGER, source: T.STRING(40), resumeRef: T.STRING(500), workAuthorized: T.BOOLEAN, needsSponsorship: T.BOOLEAN,
  history: T.JSON, answers: T.JSON, screening: T.JSON, consentAt: T.DATE, duplicateOf: T.INTEGER, rejectReason: T.STRING(40), rejectedAt: T.DATE, employeeId: T.INTEGER, hiredAt: T.DATE },
  { indexes: [{ fields: ['requisitionId', 'stage'] }, { fields: ['email'] }] } as any);
export const AuditLog = d('AuditLog', { actorId: T.INTEGER, action: T.STRING, detail: T.TEXT });

// P15 benefits enrollment
export const BenefitEnrollment = d('BenefitEnrollment', { employeeId: T.INTEGER, plan: T.STRING, coverage: T.STRING, effectiveDate: T.DATEONLY,
  monthlyEmployee: { type: T.DECIMAL(10, 2), defaultValue: 0 }, monthlyEmployer: { type: T.DECIMAL(10, 2), defaultValue: 0 }, preTax: { type: T.BOOLEAN, defaultValue: true },
  dependents: T.JSON, status: { type: T.ENUM('pending_docs', 'active', 'rejected', 'waived'), defaultValue: 'active' }, comment: T.STRING });

// P1 breaks, timesheets, P13 corrections
export const AttendanceBreak = d('AttendanceBreak', { attendanceId: T.INTEGER, startAt: T.DATE, endAt: T.DATE });
export const Timesheet = d('Timesheet', { employeeId: T.INTEGER, periodStart: T.DATEONLY, periodEnd: T.DATEONLY,
  status: { type: T.ENUM('submitted', 'approved', 'rejected'), defaultValue: 'submitted' },
  payrollStatus: { type: T.ENUM('none', 'ready', 'locked', 'exported'), defaultValue: 'none' },
  regularHours: { type: T.DECIMAL(7, 2), defaultValue: 0 }, otHours: { type: T.DECIMAL(7, 2), defaultValue: 0 }, dtHours: { type: T.DECIMAL(7, 2), defaultValue: 0 },
  version: { type: T.INTEGER, defaultValue: 1 }, decidedBy: T.INTEGER, comment: T.STRING(1000) },
  { indexes: [{ unique: true, fields: ['employeeId', 'periodStart'] }] } as any);
export const TimesheetCorrection = d('TimesheetCorrection', { timesheetId: T.INTEGER, employeeId: T.INTEGER, attendanceId: T.INTEGER,
  oldClockIn: T.DATE, oldClockOut: T.DATE, newClockIn: T.DATE, newClockOut: T.DATE, reason: T.STRING(1000),
  status: { type: T.ENUM('pending', 'approved', 'rejected'), defaultValue: 'pending' }, appliedTo: T.ENUM('current_period', 'next_period'),
  hoursDelta: T.DECIMAL(7, 2), decidedBy: T.INTEGER, comment: T.STRING(1000) });

// ---- P5 onboarding / P7 credentials / P8 offboarding (employee lifecycle) ----
export const Notification = d('Notification', { userId: T.INTEGER, type: T.STRING(60), title: T.STRING(200), body: T.STRING(1000), entityType: T.STRING(60), entityId: T.INTEGER, readAt: T.DATE },
  { indexes: [{ fields: ['userId', 'readAt'] }] } as any);
/** I-9 / W-4 payloads. `data` is AES-256-GCM ciphertext (see lifecycleCore.ts); plaintext never reaches the database. */
export const SensitiveForm = d('SensitiveForm', { employeeId: T.INTEGER, form: T.ENUM('i9_s1', 'i9_s2', 'w4'), data: T.TEXT, completedAt: T.DATE, completedBy: T.INTEGER },
  { indexes: [{ unique: true, fields: ['employeeId', 'form'] }] } as any);
export const PolicySignature = d('PolicySignature', { employeeId: T.INTEGER, document: T.STRING(60), version: T.STRING(20), signedName: T.STRING(120), ip: T.STRING(64), userAgent: T.STRING(255), signedAt: T.DATE },
  { indexes: [{ unique: true, fields: ['employeeId', 'document', 'version'] }] } as any);
export const EmergencyContact = d('EmergencyContact', { employeeId: { type: T.INTEGER, unique: true }, name: T.STRING(120), relationship: T.STRING(60), phone: T.STRING(30) });
export const Asset = d('Asset', { employeeId: T.INTEGER, item: T.STRING(120), assetTag: T.STRING(60), status: { type: T.ENUM('assigned', 'returned', 'missing'), defaultValue: 'assigned' },
  assignedAt: T.DATEONLY, returnedAt: T.DATEONLY, note: T.STRING(500) });
export const LifecycleTask = d('LifecycleTask', { employeeId: T.INTEGER, kind: T.ENUM('onboarding', 'offboarding'), key: T.STRING(40), title: T.STRING(200),
  ownerRole: T.ENUM('employee', 'manager', 'hr'), team: T.STRING(60), mandatory: { type: T.BOOLEAN, defaultValue: true }, auto: { type: T.BOOLEAN, defaultValue: false }, dueDate: T.DATEONLY,
  status: { type: T.ENUM('open', 'done', 'cancelled'), defaultValue: 'open' }, escalatedAt: T.DATE, completedBy: T.INTEGER, completedAt: T.DATE, note: T.STRING(500) },
  { indexes: [{ unique: true, fields: ['employeeId', 'kind', 'key'] }] } as any);
export const Offboarding = d('Offboarding', { employeeId: T.INTEGER, terminationDate: T.DATEONLY,
  reason: T.ENUM('resignation', 'layoff', 'position_eliminated', 'end_of_contract', 'performance', 'misconduct', 'retirement', 'other'), notes: T.TEXT,
  status: { type: T.ENUM('proposed', 'in_progress', 'complete', 'cancelled', 'rejected'), defaultValue: 'in_progress' }, retentionUntil: T.DATEONLY, accessRevokedAt: T.DATE, startedBy: T.INTEGER, completedAt: T.DATE,
  initiatedBy: { type: T.STRING(10), defaultValue: 'hr' }, proposedBy: T.INTEGER, originalReason: T.STRING(30), decidedBy: T.INTEGER, decisionNote: T.STRING(1000) });
export const Credential = d('Credential', { employeeId: T.INTEGER, type: T.STRING(40), name: T.STRING(160), issuer: T.STRING(160), issuedDate: T.DATEONLY, expiryDate: T.DATEONLY, documentRef: T.STRING(500),
  status: { type: T.ENUM('pending', 'verified', 'rejected', 'expired', 'superseded'), defaultValue: 'pending' }, verifiedBy: T.INTEGER, verifiedAt: T.DATE, rejectionReason: T.STRING(500),
  lastReminderDays: T.INTEGER, expiredHandledAt: T.DATE, renewsId: T.INTEGER }, { indexes: [{ fields: ['employeeId'] }, { fields: ['status', 'expiryDate'] }] } as any);
export const LIFECYCLE_MODELS = [Notification, SensitiveForm, PolicySignature, EmergencyContact, Asset, LifecycleTask, Offboarding, Credential];

// ---- P6 / S1-S3 recruitment ----
export const Requisition = d('Requisition', { title: T.STRING(160), department: T.STRING(80), workState: T.STRING(2), city: T.STRING(80), employmentType: { type: T.ENUM('full_time', 'part_time', 'contract'), defaultValue: 'full_time' },
  payType: { type: T.ENUM('hourly', 'salary'), defaultValue: 'salary' }, payMin: T.DECIMAL(12, 2), payMax: T.DECIMAL(12, 2), headcount: { type: T.INTEGER, defaultValue: 1 }, hired: { type: T.INTEGER, defaultValue: 0 },
  justification: T.STRING(1000), description: T.TEXT, minQuals: T.JSON, questions: T.JSON, criteria: T.JSON, channels: T.JSON,
  status: { type: T.ENUM('draft', 'pending_approval', 'approved', 'open', 'on_hold', 'filled', 'closed', 'rejected'), defaultValue: 'draft' },
  requestedBy: T.INTEGER, decidedBy: T.INTEGER, decidedAt: T.DATE, decisionNote: T.STRING(500), postedAt: T.DATE, closesAt: T.DATEONLY, version: { type: T.INTEGER, defaultValue: 1 } },
  { indexes: [{ fields: ['status'] }] } as any);
export const Interview = d('Interview', { candidateId: T.INTEGER, requisitionId: T.INTEGER, scheduledAt: T.DATE, format: { type: T.ENUM('phone', 'video', 'onsite'), defaultValue: 'video' }, location: T.STRING(300),
  panel: T.JSON, accommodationContact: T.STRING(160), status: { type: T.ENUM('scheduled', 'completed', 'cancelled'), defaultValue: 'scheduled' }, createdBy: T.INTEGER }, { indexes: [{ fields: ['candidateId'] }] } as any);
export const Scorecard = d('Scorecard', { interviewId: T.INTEGER, candidateId: T.INTEGER, interviewerId: T.INTEGER, scores: T.JSON, total: T.DECIMAL(5, 2),
  recommendation: T.ENUM('strong_yes', 'yes', 'no', 'strong_no'), notes: T.STRING(2000) }, { indexes: [{ unique: true, fields: ['interviewId', 'interviewerId'] }, { fields: ['candidateId'] }] } as any);
export const Offer = d('Offer', { candidateId: T.INTEGER, requisitionId: T.INTEGER, title: T.STRING(160), payType: T.ENUM('hourly', 'salary'), rate: T.DECIMAL(12, 2), flsaExempt: { type: T.BOOLEAN, defaultValue: false }, startDate: T.DATEONLY, deadline: T.DATEONLY,
  contingencies: T.STRING(500), status: { type: T.ENUM('pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired', 'withdrawn'), defaultValue: 'pending_approval' },
  createdBy: T.INTEGER, approvedBy: T.INTEGER, approvedAt: T.DATE, sentAt: T.DATE, respondedAt: T.DATE, version: { type: T.INTEGER, defaultValue: 1 } }, { indexes: [{ fields: ['candidateId'] }] } as any);
export const StageHistory = d('StageHistory', { candidateId: T.INTEGER, fromStage: T.STRING(20), toStage: T.STRING(20), actorId: T.INTEGER, reason: T.STRING(500) }, { indexes: [{ fields: ['candidateId'] }] } as any);
export const CandidateMessage = d('CandidateMessage', { candidateId: T.INTEGER, kind: T.STRING(40), toEmail: T.STRING(160), subject: T.STRING(300), body: T.TEXT, status: { type: T.ENUM('queued', 'sent'), defaultValue: 'queued' }, sentAt: T.DATE, createdBy: T.INTEGER }, { indexes: [{ fields: ['candidateId'] }, { fields: ['status'] }] } as any);
export const BackgroundCheck = d('BackgroundCheck', { candidateId: { type: T.INTEGER, unique: true }, vendor: T.STRING(120), status: { type: T.ENUM('none', 'disclosure_sent', 'authorized', 'report_received', 'pre_adverse', 'adverse', 'cleared'), defaultValue: 'none' },
  disclosureAt: T.DATE, authorizedAt: T.DATE, reportAt: T.DATE, preAdverseAt: T.DATE, finalAt: T.DATE, clearedAt: T.DATE, note: T.STRING(500) });
export const RECRUITMENT_MODELS = [Requisition, Interview, Scorecard, Offer, StageHistory, CandidateMessage, BackgroundCheck];

// P9 / P10 / P17 / P18 compensation (money in integer cents)
export const CommissionPlan = d('CommissionPlan', { employeeId: T.INTEGER, name: T.STRING(80), kind: T.ENUM('flat', 'tiered'), rate: T.DECIMAL(6, 4), tiers: T.JSON, capCents: T.INTEGER, drawCents: { type: T.INTEGER, defaultValue: 0 }, active: { type: T.BOOLEAN, defaultValue: true }, createdBy: T.INTEGER }, { indexes: [{ fields: ['employeeId', 'active'] }] } as any);
export const Sale = d('Sale', { employeeId: T.INTEGER, planId: T.INTEGER, saleDate: T.DATEONLY, amountCents: T.INTEGER, splitPct: { type: T.INTEGER, defaultValue: 100 }, description: T.STRING(200), enteredBy: T.INTEGER,
  commissionPaidCents: { type: T.INTEGER, defaultValue: 0 }, refundCents: { type: T.INTEGER, defaultValue: 0 }, refundedAt: T.DATEONLY, clawbackPeriod: T.STRING(7) }, { indexes: [{ fields: ['employeeId', 'saleDate'] }] } as any);
export const CommissionLine = d('CommissionLine', { employeeId: T.INTEGER, period: T.STRING(7), creditedCents: T.INTEGER, earnedCents: T.INTEGER, drawCents: T.INTEGER, extraCents: T.INTEGER, shortfallCents: T.INTEGER, clawbackCents: T.INTEGER, payableCents: T.INTEGER,
  status: { type: T.ENUM('draft', 'approved', 'returned', 'locked'), defaultValue: 'draft' }, comment: T.STRING, decidedBy: T.INTEGER }, { indexes: [{ unique: true, fields: ['employeeId', 'period'] }] } as any);
export const Bonus = d('Bonus', { employeeId: T.INTEGER, kind: T.ENUM('annual', 'spot', 'signing', 'retention', 'referral'), amountCents: T.INTEGER, discretionary: { type: T.BOOLEAN, defaultValue: true }, reason: T.STRING(300), payPeriod: T.STRING(7),
  status: { type: T.ENUM('proposed', 'approved', 'rejected', 'paid', 'clawed_back'), defaultValue: 'proposed' }, proposedBy: T.INTEGER, decidedBy: T.INTEGER, comment: T.STRING, withholdingCents: { type: T.INTEGER, defaultValue: 0 },
  clawbackWindowMonths: { type: T.INTEGER, defaultValue: 12 }, agreementOnFile: { type: T.BOOLEAN, defaultValue: false }, paidAt: T.DATEONLY, clawbackMethod: T.STRING(20), clawbackApplied: { type: T.BOOLEAN, defaultValue: false } }, { indexes: [{ fields: ['employeeId', 'payPeriod'] }] } as any);
export const PayChange = d('PayChange', { employeeId: T.INTEGER, proposedBy: T.INTEGER, payType: T.ENUM('hourly', 'salary'), hourlyCents: T.INTEGER, annualCents: T.INTEGER, flsaExempt: { type: T.BOOLEAN, defaultValue: false }, effectiveDate: T.DATEONLY, reason: T.STRING(300),
  status: { type: T.ENUM('pending', 'approved', 'rejected'), defaultValue: 'pending' }, budgetApproved: { type: T.BOOLEAN, defaultValue: false }, warnings: T.JSON, comment: T.STRING, decidedBy: T.INTEGER, applied: { type: T.BOOLEAN, defaultValue: false }, oldPay: T.JSON });
export const COMP_MODELS = [CommissionPlan, Sale, CommissionLine, Bonus, PayChange];

// P14 platform: companies, server-side sessions, security events
export const Company = d('Company', { name: T.STRING(160), slug: { type: T.STRING(60), unique: true }, plan: { type: T.ENUM('starter', 'growth', 'professional', 'enterprise'), defaultValue: 'starter' },
  status: { type: T.ENUM('active', 'suspended'), defaultValue: 'active' },
  subState: { type: T.ENUM('trial', 'active', 'past_due', 'read_only', 'cancel_pending', 'cancelled'), defaultValue: 'trial' }, graceEndsAt: T.DATE, periodEndsAt: T.DATE, stripeCustomerId: T.STRING(64), stripeSubscriptionId: T.STRING(64), failedAt: T.DATE });
export const Session = d('Session', { employeeId: T.INTEGER, tokenHash: { type: T.STRING(64), unique: true }, lastSeenAt: T.DATE, expiresAt: T.DATE, revokedAt: T.DATE, ip: T.STRING(64), userAgent: T.STRING(255) });
export const SecurityEvent = d('SecurityEvent', { type: T.STRING(60), employeeId: T.INTEGER, detail: T.TEXT, ip: T.STRING(64) });
export const P14_MODELS = [Company, Session, SecurityEvent];

// S8: versioned compliance rules (never edited in place: a change is a new version with an effective date)
export const ComplianceRule = d('ComplianceRule', { key: T.STRING(40), jurisdiction: T.STRING(20), effectiveDate: T.DATEONLY, version: T.INTEGER, value: T.JSON,
  sourceUrl: T.STRING(500), legalOwner: T.STRING(120), verified: { type: T.BOOLEAN, defaultValue: false }, createdBy: T.INTEGER });
export const S6_MODELS = [ComplianceRule];

// P19 part-time, P16 sick-leave ledger, P15 plans and enrollment windows
export const PartTimeReview = d('PartTimeReview', { employeeId: T.INTEGER, quarter: T.STRING(8), avgWeekly: T.DECIMAL(6, 1), aca: T.BOOLEAN, decision: T.STRING(12), note: T.STRING(1000), decidedBy: T.INTEGER },
  { indexes: [{ unique: true, fields: ['employeeId', 'quarter'] }] });
export const SchedulePost = d('SchedulePost', { employeeId: T.INTEGER, weekStart: T.DATEONLY, shifts: T.TEXT, publishedAt: T.DATE, publishedBy: T.INTEGER, noticeDays: T.INTEGER, lateNotice: T.BOOLEAN, changeLog: { type: T.JSON, defaultValue: [] } },
  { indexes: [{ unique: true, fields: ['employeeId', 'weekStart'] }] });
export const PslLedger = d('PslLedger', { employeeId: T.INTEGER, kind: T.STRING(10), periodStart: T.DATEONLY, periodEnd: T.DATEONLY, hoursWorked: T.DECIMAL(8, 2), accrued: T.DECIMAL(8, 2), ruleJurisdiction: T.STRING(20), ruleVersion: T.INTEGER, note: T.STRING(500) },
  { indexes: [{ unique: true, fields: ['employeeId', 'kind', 'periodStart', 'periodEnd'] }] });
export const BenefitPlan = d('BenefitPlan', { code: T.STRING(40), name: T.STRING(160), catalogItem: T.STRING(120), employerPct: T.INTEGER, minHours: T.INTEGER, waitingDays: { type: T.INTEGER, defaultValue: 30 }, windowDays: { type: T.INTEGER, defaultValue: 30 },
  preTax: T.BOOLEAN, cost: T.JSON, active: { type: T.BOOLEAN, defaultValue: true } }, { indexes: [{ unique: true, fields: ['companyId', 'code'] }] });
export const EnrollmentWindow = d('EnrollmentWindow', { kind: T.STRING(12), employeeId: T.INTEGER, startDate: T.DATEONLY, endDate: T.DATEONLY, event: T.STRING(30), createdBy: T.INTEGER, voidedAt: T.DATE });
export const P15_MODELS = [PartTimeReview, SchedulePost, PslLedger, BenefitPlan, EnrollmentWindow];

// P20/P21/S7 unemployment claims and A8 insurance register
export const UiClaim = d('UiClaim', { employeeId: T.INTEGER, offboardingId: T.INTEGER, state: T.STRING(2), uiReason: T.STRING(30), reasonNote: T.STRING(1000), lastDay: T.DATEONLY, agencyClaimId: T.STRING(60), claimFiledDate: T.DATEONLY,
  agencyNoticeDate: T.DATEONLY, responseDays: T.INTEGER, responseDue: T.DATEONLY, status: { type: T.ENUM('open', 'response_due', 'responded', 'determined', 'appealed', 'closed'), defaultValue: 'open' },
  responseStatus: { type: T.ENUM('not_requested', 'pending', 'submitted', 'submitted_late', 'missed'), defaultValue: 'not_requested' }, responseText: T.TEXT, respondedAt: T.DATE, remindedAt: T.DATE, lateEscalatedAt: T.DATE,
  agencyDecision: { type: T.ENUM('pending', 'eligible', 'denied'), defaultValue: 'pending' }, decisionDate: T.DATEONLY, decisionNotes: T.STRING(1000), weeklyBenefit: T.DECIMAL(10, 2), benefitWeeks: T.INTEGER, appealDays: T.INTEGER, appealDeadline: T.DATEONLY,
  createdBy: T.INTEGER, closedAt: T.DATE, closeNote: T.STRING(1000) });
export const UiEvidence = d('UiEvidence', { claimId: T.INTEGER, kind: T.STRING(20), title: T.STRING(200), description: T.TEXT, source: T.STRING(200), docDate: T.DATEONLY, addedBy: T.INTEGER });
export const UiCorrespondence = d('UiCorrespondence', { claimId: T.INTEGER, direction: T.STRING(12), occurredOn: T.DATEONLY, summary: T.TEXT, createdBy: T.INTEGER });
export const UiAppeal = d('UiAppeal', { claimId: T.INTEGER, side: T.STRING(10), filedDate: T.DATEONLY, notes: T.TEXT, createdBy: T.INTEGER });
export const InsurancePolicy = d('InsurancePolicy', { type: T.STRING(80), insurer: T.STRING(160), policyNumber: T.STRING(80), coverageLimit: T.DECIMAL(14, 2), premium: T.DECIMAL(12, 2), premiumFrequency: T.STRING(10),
  effectiveDate: T.DATEONLY, expirationDate: T.DATEONLY, exclusions: T.TEXT, claimsContact: T.JSON, status: { type: T.ENUM('active', 'expired', 'cancelled'), defaultValue: 'active' }, notes: T.TEXT, remindersSent: { type: T.JSON, defaultValue: [] }, createdBy: T.INTEGER },
  { indexes: [{ unique: true, fields: ['companyId', 'type', 'policyNumber'] }] });
export const InsuredItem = d('InsuredItem', { policyId: T.INTEGER, kind: T.STRING(10), employeeId: T.INTEGER, label: T.STRING(200), details: T.TEXT });
export const InsuranceDocument = d('InsuranceDocument', { policyId: T.INTEGER, kind: T.STRING(20), title: T.STRING(200), reference: T.STRING(500), issuedDate: T.DATEONLY, addedBy: T.INTEGER });
export const P20_MODELS = [UiClaim, UiEvidence, UiCorrespondence, UiAppeal, InsurancePolicy, InsuredItem, InsuranceDocument];

// S4 training, S5 performance / warnings / PIP
export const Course = d('Course', { title: T.STRING(200), description: T.TEXT, category: T.STRING(20), deliveryMethod: T.STRING(20), version: T.STRING(20), prerequisiteId: T.INTEGER, passScore: T.INTEGER, recurrenceMonths: T.INTEGER, active: { type: T.BOOLEAN, defaultValue: true }, createdBy: T.INTEGER });
export const CourseAssignment = d('CourseAssignment', { courseId: T.INTEGER, employeeId: T.INTEGER, courseVersion: T.STRING(20), assignedBy: T.INTEGER, dueDate: T.DATEONLY, startedAt: T.DATE, completedAt: T.DATE, score: T.INTEGER, attempts: { type: T.INTEGER, defaultValue: 0 },
  certificateRef: T.STRING(300), recordedBy: T.INTEGER, remindedAt: T.DATE, overdueNotifiedAt: T.DATE, recurredFromId: T.INTEGER });
export const CompetencyReview = d('CompetencyReview', { employeeId: T.INTEGER, reviewerId: T.INTEGER, notes: T.TEXT, outcome: T.STRING(12), followUpDate: T.DATEONLY });
export const GoalSet = d('GoalSet', { employeeId: T.INTEGER, version: T.INTEGER, goals: T.JSON, reviewDate: T.DATEONLY, setBy: T.INTEGER, acknowledgedAt: T.DATE });
export const Evaluation = d('Evaluation', { employeeId: T.INTEGER, reviewerId: T.INTEGER, periodStart: T.DATEONLY, periodEnd: T.DATEONLY, kind: T.STRING(12), score: T.INTEGER, strengths: T.TEXT, gaps: T.TEXT, expectations: T.TEXT, conductNote: T.TEXT,
  improvementNeeded: T.BOOLEAN, evidence: { type: T.JSON, defaultValue: [] }, status: { type: T.ENUM('draft', 'delivered', 'acknowledged'), defaultValue: 'draft' }, employeeResponse: T.TEXT, deliveredAt: T.DATE, acknowledgedAt: T.DATE });
export const Warning = d('Warning', { employeeId: T.INTEGER, level: T.STRING(14), issue: T.TEXT, standard: T.TEXT, support: T.TEXT, timeline: T.TEXT, consequences: T.TEXT, policyVersion: T.STRING(30), consistencyNote: T.TEXT, evaluationId: T.INTEGER, reviewDeadline: T.DATEONLY,
  status: { type: T.ENUM('pending_approval', 'issued', 'acknowledged', 'refused', 'withdrawn'), defaultValue: 'issued' }, authoredBy: T.INTEGER, approvedBy: T.INTEGER, issuedAt: T.DATE, ackNote: T.TEXT, witness: T.STRING(200), withdrawnNote: T.STRING(1000) });
export const Pip = d('Pip', { employeeId: T.INTEGER, warningId: T.INTEGER, startDate: T.DATEONLY, endDate: T.DATEONLY, goals: T.JSON, support: T.TEXT, checkins: { type: T.JSON, defaultValue: [] }, extensions: { type: T.INTEGER, defaultValue: 0 },
  status: { type: T.ENUM('active', 'closed_success', 'closed_reassign', 'closed_termination_review'), defaultValue: 'active' }, outcomeNote: T.TEXT, finalReviewDone: T.BOOLEAN, hrLegalReviewed: T.BOOLEAN, hrLegalNote: T.TEXT, grievanceNote: T.TEXT, decidedBy: T.INTEGER, createdBy: T.INTEGER });
export const S4S5_MODELS = [Course, CourseAssignment, CompetencyReview, GoalSet, Evaluation, Warning, Pip];

// P4 review/approval/unlock history and P3
export const PayAdjustment = d('PayAdjustment', { sheetId: T.INTEGER, employeeId: T.INTEGER, period: T.STRING(7), version: T.INTEGER, amount: T.DECIMAL(10, 2), reason: T.STRING(1000), adjustedBy: T.INTEGER });
export const PayrollVersion = d('PayrollVersion', { sheetId: T.INTEGER, employeeId: T.INTEGER, period: T.STRING(7), version: T.INTEGER, gross: T.DECIMAL(10, 2), net: T.DECIMAL(10, 2), lockedAt: T.DATE, unlockedBy: T.INTEGER, unlockReason: T.STRING(1000) });
export const PayrollExport = d('PayrollExport', { period: T.STRING(7), rows: T.INTEGER, fileHash: T.STRING(64), exportedBy: T.INTEGER, versionMax: T.INTEGER });
export const P4_MODELS = [PayAdjustment, PayrollVersion, PayrollExport];

// Stripe billing (P11/P12), outgoing e-mail log and the AI assistant (pending actions + audit)
/** Stripe webhook idempotency: one row per event id (platform level, not tied to a company). */
export const StripeEvent = d('StripeEvent', { eventId: { type: T.STRING(80), unique: true }, type: T.STRING(80), outcome: T.STRING(200) });
export const EmailLog = d('EmailLog', { kind: T.STRING(40), toEmail: T.STRING(160), subject: T.STRING(300), status: T.ENUM('sent', 'failed', 'skipped'), error: T.STRING(500) }, { indexes: [{ fields: ['status'] }] } as any);
/** A write the assistant PROPOSED. Nothing happens until the same person confirms it (and permissions are checked again at that moment). */
export const AiAction = d('AiAction', { userId: T.INTEGER, tool: T.STRING(40), args: T.JSON, summary: T.STRING(500), status: { type: T.ENUM('pending', 'confirmed', 'cancelled', 'expired', 'failed'), defaultValue: 'pending' }, result: T.TEXT, decidedAt: T.DATE },
  { indexes: [{ fields: ['userId', 'status'] }] } as any);
export const AiAudit = d('AiAudit', { userId: T.INTEGER, kind: T.STRING(20), tool: T.STRING(40), detail: T.TEXT, ok: { type: T.BOOLEAN, defaultValue: true } }, { indexes: [{ fields: ['userId'] }] } as any);
export const BILLING_MODELS = [StripeEvent, EmailLog, AiAction, AiAudit];
/** Saved assistant conversations. Each one belongs to one person and is shown only to them. `messages` is a JSON string (TEXT) so it reads back the same on every database. */
export const AiChat = d('AiChat', { userId: T.INTEGER, title: T.STRING(120), messages: T.TEXT('long') }, { indexes: [{ fields: ['userId', 'updatedAt'] }] } as any);