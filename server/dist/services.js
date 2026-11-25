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
Object.defineProperty(exports, "__esModule", { value: true });
exports.inScope = exports.isStaff = exports.isHR = exports.HttpErr = exports.PLANS = exports.sickRule = exports.SICK_REASONS = exports.SALARY_FLOOR = exports.sickHours = exports.log = void 0;
exports.submitLeave = submitLeave;
exports.teamOf = teamOf;
exports.scopeIds = scopeIds;
exports.approverCheck = approverCheck;
const M = __importStar(require("./models"));
const log = (actorId, action, detail = '') => M.AuditLog.create({ actorId, action, detail });
exports.log = log;
// P2: balance check -> auto reject or reserve pending hours
async function submitLeave(userId, b) {
    if (b.type === 'Sick') { // P16 validation: qualifying reason + waiting period
        const emp = await M.Employee.findByPk(userId);
        const rule = (0, exports.sickRule)(emp?.workState);
        const ok = exports.SICK_REASONS.includes(b.reason || '');
        const eligibleFrom = new Date(new Date(emp?.startDate || Date.now()).getTime() + rule.waitingDays * 864e5).toISOString().slice(0, 10);
        const why = !ok ? 'Reason is not a qualifying sick leave reason' : b.startDate < eligibleFrom ? `Waiting period: sick leave can be used from ${eligibleFrom}` : '';
        if (why)
            return M.LeaveRequest.create({ employeeId: userId, ...b, status: 'rejected', comment: 'Auto rejected: ' + why });
    }
    const bal = await M.LeaveBalance.findOne({ where: { employeeId: userId, type: b.type } });
    const avail = bal ? bal.total - bal.used - bal.pending : 0;
    if (b.type !== 'Unpaid' && avail < b.hours)
        return M.LeaveRequest.create({ employeeId: userId, ...b, status: 'rejected', comment: 'Auto rejected: insufficient balance' });
    if (bal) {
        bal.pending += +b.hours;
        await bal.save();
    }
    await (0, exports.log)(userId, 'Leave Requested', `${b.type} ${b.hours}h`);
    return M.LeaveRequest.create({ employeeId: userId, ...b });
}
// P16: paid sick hours per year by work state (2026 mandates, see Appendix A2). Others use company policy default.
const SICK = { AK: 56, AZ: 40, CA: 40, CO: 48, CT: 40, DC: 56, IL: 40, ME: 40, MD: 40, MA: 40, MI: 72, MN: 48, NE: 40, NV: 40, NJ: 40, NM: 64, NY: 56, OR: 40, RI: 40, VT: 40, WA: 40 };
const sickHours = (state) => SICK[(state || '').toUpperCase()] ?? 40;
exports.sickHours = sickHours;
// P17: federal + state exempt salary floors, annual (Appendix A4)
exports.SALARY_FLOOR = { US: 35568, CA: 70304, WA: 80168.4, NY: 62353.2, CO: 57783.96, ME: 45300.32 };
exports.SICK_REASONS = ['Own illness or injury', 'Care for family member', 'Preventive or medical care', 'Safe leave (domestic violence, stalking)', 'Public health closure', 'Bereavement', 'Blood donation (OR)'];
const RATE = { DC: 37, IL: 40, ME: 40, NV: 52, VT: 52, RI: 35, WA: 40 };
// P16 rule set per jurisdiction (Appendix A3 fields). Waiting period: most states allow up to 90 days; use 0 where earned from day one is common.
const sickRule = (state) => {
    const st = (state || '').toUpperCase(), mandated = st in SICK;
    return { state: st, mandated, annualHours: (0, exports.sickHours)(st), accrual: mandated ? `1 hour per ${RATE[st] || 30} hours worked` : 'Company policy', carryover: mandated ? 'Up to 40 hours' : 'Company policy', waitingDays: mandated ? 0 : 90, reasons: exports.SICK_REASONS, note: mandated ? 'Statewide paid sick leave law applies. A stricter city or county law may also apply.' : 'No statewide mandate. Company policy applies unless a local law does.' };
};
exports.sickRule = sickRule;
// P15 plan catalog: monthly premiums by coverage level, employer share %
exports.PLANS = [
    { code: 'medical', name: 'Medical (PPO)', employerPct: 70, minHours: 30, preTax: true, cost: { employee: 480, spouse: 960, children: 880, family: 1380 } },
    { code: 'dental', name: 'Dental', employerPct: 50, minHours: 30, preTax: true, cost: { employee: 38, spouse: 76, children: 82, family: 124 } },
    { code: 'vision', name: 'Vision', employerPct: 50, minHours: 20, preTax: true, cost: { employee: 12, spouse: 24, children: 26, family: 40 } },
    { code: 'life', name: 'Life and AD&D (1x salary)', employerPct: 100, minHours: 20, preTax: false, cost: { employee: 15, spouse: 15, children: 15, family: 15 } },
    { code: 'disability', name: 'Short and long-term disability', employerPct: 60, minHours: 30, preTax: false, cost: { employee: 28, spouse: 28, children: 28, family: 28 } },
    { code: 'hsa', name: 'HSA / FSA', employerPct: 0, minHours: 30, preTax: true, cost: { employee: 0, spouse: 0, children: 0, family: 0 } },
];
const sequelize_1 = require("sequelize");
class HttpErr extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
exports.HttpErr = HttpErr;
const isHR = (u) => ['admin', 'hr'].includes(u.role);
exports.isHR = isHR;
const isStaff = (u) => u.role !== 'employee';
exports.isStaff = isStaff;
/** All direct and indirect reports of a manager. */
async function teamOf(uid) {
    const out = new Set();
    let frontier = [uid];
    while (frontier.length) {
        const rows = await M.Employee.findAll({ where: { managerId: { [sequelize_1.Op.in]: frontier } }, attributes: ['id'], raw: true });
        frontier = rows.map((r) => r.id).filter((i) => i !== uid && !out.has(i));
        frontier.forEach((i) => out.add(i));
    }
    return [...out];
}
/** Employee ids the user may read. null = everyone (HR/admin). */
async function scopeIds(u) {
    if ((0, exports.isHR)(u))
        return null;
    return u.role === 'manager' ? [u.id, ...(await teamOf(u.id))] : [u.id];
}
const inScope = (ids) => (ids ? { employeeId: { [sequelize_1.Op.in]: ids } } : {});
exports.inScope = inScope;
/** May `u` act (approve/reject) on `employeeId`'s item? Never on their own. */
async function approverCheck(u, employeeId) {
    if (u.id === employeeId)
        return 'self';
    if ((0, exports.isHR)(u))
        return 'ok';
    if (u.role === 'manager' && (await teamOf(u.id)).includes(employeeId))
        return 'ok';
    return 'forbidden';
}
