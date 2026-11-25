"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
(async () => {
    if (process.env.NODE_ENV === 'production') {
        console.error('Refusing to wipe the database in production.');
        process.exit(1);
    }
    await M.sequelize.sync({ force: true });
    const co = await M.Company.create({ name: 'Demo Company', slug: 'demo', plan: 'professional', subState: 'trial' });
    await (0, tenancy_1.runAs)(co.id, async () => {
        const pw = bcryptjs_1.default.hashSync('Admin123!', 12);
        const people = [['Admin', 'admin@ams.com', 'admin', 'HR', 'HR Director', 0], ['Sarah Khan', 'sarah@ams.com', 'manager', 'Engineering', 'Engineering Manager', 45], ['Ali Raza', 'ali@ams.com', 'employee', 'Engineering', 'Developer', 32], ['Usman Ahmed', 'usman@ams.com', 'employee', 'Engineering', 'Software Engineer', 38], ['Ayesha Malik', 'ayesha@ams.com', 'employee', 'Support', 'Support Agent', 22]];
        for (const [name, email, role, department, title, hourlyRate] of people) {
            const e = await M.Employee.create({ name, email, role, department, title, hourlyRate, password: pw });
            if (role === 'employee')
                await e.update({ managerId: 2 });
            await M.LeaveBalance.create({ employeeId: e.id, type: 'Annual', total: 160, used: 96, pending: 16 });
            await M.LeaveBalance.create({ employeeId: e.id, type: 'Sick', total: 40 });
            for (let i = 30; i >= 0; i--) {
                if ([0, 6].includes(new Date(day(-i)).getDay()))
                    continue;
                const st = Math.random() < 0.85 ? 'present' : Math.random() < 0.6 ? 'absent' : 'leave';
                await M.Attendance.create({ employeeId: e.id, date: day(-i), status: st, hours: st === 'present' ? 7 + Math.random() * 3 : 0 });
            }
        }
        await M.ComplianceTask.bulkCreate([{ employeeId: 3, type: 'Payroll Processing', dueDate: day(3) }, { employeeId: 4, type: 'Team Meeting', dueDate: day(4) }, { employeeId: 5, type: 'Leave Request Deadline', dueDate: day(8) }, { employeeId: 3, type: 'I-9 Section 2', dueDate: day(-2) }]);
        // ---- P6 / S1-S3 demo recruitment data ----
        const hoursAgo = (h) => new Date(Date.now() - h * 36e5), inDays = (n) => new Date(Date.now() + n * 864e5);
        const Q = { questions: ['Describe a defect you found that others missed and how you reported it.', 'Which test automation tools have you used in production?'], minQuals: ['3+ years in software QA', 'Experience with automated testing'], criteria: [{ key: 'skills', label: 'Skills for the role', weight: 40 }, { key: 'experience', label: 'Relevant experience', weight: 30 }, { key: 'credentials', label: 'Education, licenses, certifications', weight: 15 }, { key: 'availability', label: 'Availability and schedule fit', weight: 15 }] };
        const rq = async (v) => (await M.Requisition.create({ headcount: 1, payType: 'salary', employmentType: 'full_time', channels: ['Careers page', 'Job boards'], postedAt: hoursAgo(120), version: 1, ...v }));
        const qa = await rq({ title: 'Senior QA Engineer', department: 'Engineering', workState: 'TX', city: 'Austin', payMin: 95000, payMax: 125000, headcount: 2, justification: 'Two releases per month need dedicated QA ownership.', description: 'Own test strategy for our HR platform. Design automated suites, triage defects with developers, and gate releases.\n\nYou will work with a small, senior engineering team.', ...Q, status: 'open', requestedBy: 2, decidedBy: 1, decidedAt: hoursAgo(130) });
        const sup = await rq({ title: 'Customer Support Specialist', department: 'Support', workState: 'CA', city: 'Los Angeles', payType: 'hourly', payMin: 24, payMax: 30, justification: 'Ticket volume doubled after the spring launch.', description: 'Help customers solve payroll and HR questions by chat and email. Escalate bugs with clear reproduction steps.', minQuals: ['1+ year in customer support'], questions: ['Describe a time you turned around an unhappy customer.'], criteria: Q.criteria, status: 'open', requestedBy: 2, decidedBy: 1, decidedAt: hoursAgo(100) });
        await rq({ title: 'Product Designer', department: 'Design', workState: 'NY', city: 'New York', payMin: 90000, payMax: 115000, justification: 'Dashboard redesign needs a dedicated designer.', description: 'Design workflows for HR, payroll and compliance products. Work from research to polished UI.', minQuals: ['Portfolio of shipped product work'], questions: [], criteria: Q.criteria, status: 'pending_approval', requestedBy: 2, postedAt: null, channels: null });
        await rq({ title: 'Payroll Analyst', department: 'Finance', workState: 'TX', city: 'Austin', justification: 'Backfill for upcoming leave.', description: 'Prepare and audit pay sheets, reconcile exports with providers, and resolve exceptions.', minQuals: [], questions: [], criteria: Q.criteria, status: 'draft', requestedBy: 2, postedAt: null, channels: null });
        const hist = (e, t, st = 'unverified') => [{ employer: e, title: t, status: st }];
        const answers = { 0: 'I traced intermittent payroll rounding errors to a locale-specific parse and wrote a regression suite.', 1: 'Playwright and Cypress for UI, Vitest for services, k6 for load.' };
        const scr = (r, meets = true, why = 'Strong written answers and relevant tooling.') => { const w = [40, 30, 15, 15], score = Math.round(r.reduce((a, v, i) => a + ((v - 1) / 4) * w[i], 0) * 10) / 10; return { ratings: { skills: r[0], experience: r[1], credentials: r[2], availability: r[3] }, score, checks: [meets, meets], meetsAll: meets, rationale: why, reviewerId: 1, at: new Date().toISOString() }; };
        const cd = async (req, name, stage, ago, extra = {}, src = 'Careers page') => {
            const c = await M.Candidate.create({ name, email: name.toLowerCase().replace(/[^a-z]/g, '') + '@mail.example', phone: '+1 512 555 01' + String(10 + Math.floor(Math.random() * 80)), position: req.title, requisitionId: req.id, stage, source: src, resumeRef: 'https://example.com/resume/' + name.split(' ')[0].toLowerCase() + '.pdf', workAuthorized: true, needsSponsorship: false, history: hist('Previous employer', 'Specialist'), answers, consentAt: hoursAgo(ago), ...extra });
            await M.Candidate.update({ createdAt: hoursAgo(ago) }, { where: { id: c.id }, silent: true });
            await M.StageHistory.create({ candidateId: c.id, fromStage: null, toStage: 'received', actorId: 0, reason: 'Applied via ' + src, createdAt: hoursAgo(ago) });
            return c;
        };
        const mv = (c, from, to, actor = 1, reason = '') => M.StageHistory.create({ candidateId: c.id, fromStage: from, toStage: to, actorId: actor, reason });
        await cd(qa, 'Daniyal Qureshi', 'received', 5, {}, 'Job boards');
        await cd(qa, 'Zainab Hussain', 'received', 20, {}, 'Professional network');
        await cd(sup, 'Jessica Miller', 'received', 8);
        const hina = await cd(qa, 'Hina Tariq', 'screening', 70, { screening: scr([4, 4, 4, 5]), history: hist('Systems Ltd', 'QA Engineer', 'verified') });
        await mv(hina, 'received', 'screening', 1, 'Screening started');
        const kev = await cd(sup, 'Kevin Brown', 'screening', 50, { screening: scr([3, 4, 3, 4], true, 'Solid support background; needs a chat skills check.') }, 'Referrals');
        await mv(kev, 'received', 'screening', 1, 'Screening started');
        const bil = await cd(qa, 'Bilal Sheikh', 'interview', 96, { screening: scr([5, 4, 4, 4]), history: hist('Folio3', 'Senior QA', 'verified') });
        await mv(bil, 'received', 'screening', 1);
        await mv(bil, 'screening', 'interview', 1);
        const iv = await M.Interview.create({ candidateId: bil.id, requisitionId: qa.id, scheduledAt: inDays(2), format: 'video', location: 'https://meet.example.com/ams-qa-bilal', panel: [2, 3], accommodationContact: 'HR team', createdBy: 1 });
        const sara = await cd(qa, 'Sara Ahmed', 'offer', 168, { screening: scr([5, 5, 4, 5]), history: hist('10Pearls', 'QA Lead', 'verified') }, 'Referrals');
        await mv(sara, 'received', 'screening', 1);
        await mv(sara, 'screening', 'interview', 1);
        await mv(sara, 'interview', 'offer', 2, 'Hiring manager approved');
        const siv = await M.Interview.create({ candidateId: sara.id, requisitionId: qa.id, scheduledAt: hoursAgo(72), format: 'onsite', location: 'Austin office', panel: [2, 3], accommodationContact: 'HR team', status: 'completed', createdBy: 1 });
        const note = 'Walked through her test pyramid with concrete incidents; asked sharp questions about release gating.';
        for (const [who, rec, n] of [[2, 'strong_yes', 5], [3, 'yes', 4]])
            await M.Scorecard.create({ interviewId: siv.id, candidateId: sara.id, interviewerId: who, scores: { role: n, problem: n, communication: 4, teamwork: n, motivation: 5 }, total: Math.round((((n * 3 + 4 + 5) / 5 - 1) / 4) * 1000) / 10, recommendation: rec, notes: note });
        await M.Offer.create({ candidateId: sara.id, requisitionId: qa.id, title: 'Senior QA Engineer', payType: 'salary', rate: 118000, startDate: day(30), deadline: day(10), contingencies: 'Satisfactory reference check and I-9 verification', createdBy: 1, status: 'pending_approval' });
        await cd(qa, 'Maria Lopez', 'talent_pool', 200, { screening: scr([3, 3, 3, 3], true, 'Good fit but a more senior hire was chosen. Keep for future roles.') }, 'Staffing agency');
        const om = await cd(qa, 'Omar Farooq', 'rejected', 240, { screening: scr([2, 1, 3, 3], false, 'Below the minimum years of QA experience.'), rejectReason: 'not_qualified', rejectedAt: hoursAgo(200) });
        await mv(om, 'received', 'rejected', 1, 'Does not meet the minimum qualifications');
        await M.CandidateMessage.bulkCreate([{ candidateId: bil.id, kind: 'interview_invite', toEmail: bil.email, subject: 'Interview invitation: Senior QA Engineer', body: 'Hello Bilal Sheikh,\n\nThank you for your interest in Senior QA Engineer. We would like to invite you to an interview.\n\nFormat: video\nPanel: Sarah Khan, Ali Raza\n\nIf you need a reasonable accommodation, contact our HR team.\n\nTalent Team\nAMS', createdBy: 1 }]);
        await M.AuditLog.bulkCreate([{ actorId: 2, action: 'Leave Request Approved', detail: 'Sarah Khan · Annual Leave · 2 days' }, { actorId: 3, action: 'Timesheet Submitted', detail: 'Ali Raza' }]);
    });
    console.log('Seeded company "demo". Login: admin@ams.com / Admin123!. Careers page: /careers/demo. Create the platform owner with: npm run create-superadmin -- <email> <password>');
    process.exit(0);
})();
