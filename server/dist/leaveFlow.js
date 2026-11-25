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
exports.ping = void 0;
exports.checkLeaveInput = checkLeaveInput;
exports.createLeave = createLeave;
exports.decideLeave = decideLeave;
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
const hrFlows_1 = require("./hrFlows");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ping = (userId, title, body) => userId ? M.Notification.create({ userId, kind: 'leave', title, body: body.slice(0, 1000), entityType: 'leave', entityId: 0 }).catch(() => null) : null;
exports.ping = ping;
function checkLeaveInput(b) {
    if (!['Annual', 'Sick', 'Unpaid'].includes(b?.type))
        throw (0, http_1.bad)('Unknown leave type');
    if (!DATE.test(b.startDate || '') || !DATE.test(b.endDate || '') || b.endDate < b.startDate)
        throw (0, http_1.bad)('Choose valid dates');
    if (!Number.isInteger(Number(b.hours)) || Number(b.hours) <= 0 || Number(b.hours) > 1000)
        throw (0, http_1.bad)('Hours must be a positive whole number');
}
async function createLeave(user, b) {
    checkLeaveInput(b);
    if (b.type === 'Sick') {
        const me = await M.Employee.findByPk(user.id);
        const why = await (0, hrFlows_1.sickWaitingError)(me, b.startDate);
        if (why)
            throw (0, http_1.bad)(why);
    } // P16: waiting period of the jurisdiction's rule
    const lr = await (0, services_1.submitLeave)(user.id, { ...b, hours: Number(b.hours) });
    const me2 = await M.Employee.findByPk(user.id);
    if (lr.status === 'pending')
        await (0, exports.ping)(me2?.managerId, 'Leave request awaiting approval', `${me2?.name}: ${b.type} ${b.hours}h from ${b.startDate}`); // P2: manager is told
    else
        await (0, exports.ping)(user.id, 'Leave request rejected automatically', String(lr.comment || '').replace('Auto rejected: ', '')); // P2: "Auto reject, notify employee"
    return lr;
}
/** Manager / HR / admin decision. Never your own request; managers only their own team (approverCheck). */
async function decideLeave(user, id, approve, commentIn) {
    const x = await M.LeaveRequest.findByPk(id);
    if (!x)
        throw (0, http_1.bad)('Not found', 404);
    const who = await (0, services_1.approverCheck)(user, x.employeeId);
    if (who === 'self')
        throw (0, http_1.bad)('You cannot approve your own request', 403);
    if (who !== 'ok')
        throw (0, http_1.bad)('Not allowed for your role', 403);
    const comment = String(commentIn || '').slice(0, 250);
    if (!approve && !comment)
        throw (0, http_1.bad)('A comment is required when rejecting');
    const [n] = await M.LeaveRequest.update({ status: approve ? 'approved' : 'rejected', comment: comment || null }, { where: { id: x.id, status: 'pending' } });
    if (!n)
        throw (0, http_1.bad)('Request is not pending', 400); // duplicate decision blocked
    const bal = await M.LeaveBalance.findOne({ where: { employeeId: x.employeeId, type: x.type } });
    if (bal) {
        bal.pending -= x.hours;
        if (approve)
            bal.used += x.hours;
        await bal.save();
    }
    await (0, services_1.log)(user.id, approve ? 'Leave Request Approved' : 'Leave Request Rejected', `${x.type} ${x.hours}h #${x.id}${comment ? ' ' + comment.slice(0, 120) : ''}`);
    await (0, exports.ping)(x.employeeId, approve ? 'Leave request approved' : 'Leave request rejected', `${x.type} ${x.startDate}${comment ? ': ' + comment : ''}`); // P2: employee is notified of the decision
    return M.LeaveRequest.findByPk(x.id);
}
