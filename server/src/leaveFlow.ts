/** Leave request rules shared by the REST routes and the AI assistant, so both enforce exactly the same checks. */
import { Op } from 'sequelize';
import * as M from './models';
import { log, submitLeave, approverCheck } from './services';
import { bad } from './http';
import { sickWaitingError } from './hrFlows';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ping = (userId: number | null | undefined, title: string, body: string) => userId ? M.Notification.create({ userId, kind: 'leave', title, body: body.slice(0, 1000), entityType: 'leave', entityId: 0 } as any).catch(() => null) : null;

export function checkLeaveInput(b: any) {
  if (!['Annual', 'Sick', 'Unpaid'].includes(b?.type)) throw bad('Unknown leave type');
  if (!DATE.test(b.startDate || '') || !DATE.test(b.endDate || '') || b.endDate < b.startDate) throw bad('Choose valid dates');
  if (!Number.isInteger(Number(b.hours)) || Number(b.hours) <= 0 || Number(b.hours) > 1000) throw bad('Hours must be a positive whole number');
}
export async function createLeave(user: any, b: any) {
  checkLeaveInput(b);
  if (b.type === 'Sick') { const me: any = await M.Employee.findByPk(user.id); const why = await sickWaitingError(me, b.startDate); if (why) throw bad(why); }   // P16: waiting period of the jurisdiction's rule
  const lr: any = await submitLeave(user.id, { ...b, hours: Number(b.hours) });
  const me2: any = await M.Employee.findByPk(user.id);
  if (lr.status === 'pending') await ping(me2?.managerId, 'Leave request awaiting approval', `${me2?.name}: ${b.type} ${b.hours}h from ${b.startDate}`);          // P2: manager is told
  else await ping(user.id, 'Leave request rejected automatically', String(lr.comment || '').replace('Auto rejected: ', ''));                                   // P2: "Auto reject, notify employee"
  return lr;
}
/** Manager / HR / admin decision. Never your own request; managers only their own team (approverCheck). */
export async function decideLeave(user: any, id: any, approve: boolean, commentIn: any) {
  const x: any = await M.LeaveRequest.findByPk(id);
  if (!x) throw bad('Not found', 404);
  const who = await approverCheck(user, x.employeeId);
  if (who === 'self') throw bad('You cannot approve your own request', 403);
  if (who !== 'ok') throw bad('Not allowed for your role', 403);
  const comment = String(commentIn || '').slice(0, 250);
  if (!approve && !comment) throw bad('A comment is required when rejecting');
  const [n] = await M.LeaveRequest.update({ status: approve ? 'approved' : 'rejected', comment: comment || null }, { where: { id: x.id, status: 'pending' } });
  if (!n) throw bad('Request is not pending', 400);                                  // duplicate decision blocked
  const bal: any = await M.LeaveBalance.findOne({ where: { employeeId: x.employeeId, type: x.type } });
  if (bal) { bal.pending -= x.hours; if (approve) bal.used += x.hours; await bal.save(); }
  await log(user.id, approve ? 'Leave Request Approved' : 'Leave Request Rejected', `${x.type} ${x.hours}h #${x.id}${comment ? ' ' + comment.slice(0, 120) : ''}`);
  await ping(x.employeeId, approve ? 'Leave request approved' : 'Leave request rejected', `${x.type} ${x.startDate}${comment ? ': ' + comment : ''}`);   // P2: employee is notified of the decision
  return M.LeaveRequest.findByPk(x.id);
}
