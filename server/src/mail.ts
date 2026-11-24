/** Outgoing e-mail: invitations, account notices and notification alerts. Every attempt is logged in EmailLog (never the message body or any password). */
import * as M from './models';
import { runSystem } from './tenancy';
import { cfgFromEnv, sendSmtp } from './mailer';

export const appBase = () => (process.env.APP_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
export const mailConfigured = () => !!cfgFromEnv();
let transport: typeof sendSmtp = sendSmtp;
/** Tests only: replace the SMTP transport. */
export const setMailTransport = (t: typeof sendSmtp | null) => { transport = t || sendSmtp; };
const pending = new Set<Promise<any>>();

export type MailStatus = 'sent' | 'failed' | 'skipped';
export async function sendMail(a: { to: string; subject: string; text: string; kind: string; companyId?: number | null }): Promise<MailStatus> {
  const cfg = cfgFromEnv(); let status: MailStatus = 'skipped', error: string | null = null;
  if (cfg) {
    try {
      await transport(cfg, { to: a.to, subject: a.subject, text: a.text });
      status = 'sent';
    } catch (e: any) {
      status = 'failed';
      error = String(e?.message || e).slice(0, 500);
      console.error('SMTP ERROR:', error);
    }
  }
  await runSystem(() => M.EmailLog.create({ kind: a.kind, toEmail: a.to.slice(0, 160), subject: a.subject.slice(0, 300), status, error, companyId: a.companyId ?? null } as any)).catch(() => null);
  return status;
}
/** Fire and forget: a slow or broken mail server must never slow down or fail a request. */
export function queueMail(a: Parameters<typeof sendMail>[0]) { const p = sendMail(a).catch(() => 'failed' as MailStatus).finally(() => pending.delete(p)); pending.add(p); return p; }
export const flushMail = () => Promise.all([...pending]);

export const inviteText = (name: string, company: string, url: string, hours: number) =>
  `Hello ${name},\n\nYou have been invited to ${company} on AMS HRMS as its administrator.\n\nChoose your password here (the link works once and expires in ${hours} hours):\n${url}\n\nIf you did not expect this message, ignore it.\n`;

let installed = false;
/** Optional e-mail alert for in-app notifications (NOTIFY_EMAIL=true). Only the title is sent, never the body: notifications can contain HR-sensitive detail. */
export function installNotificationMailer() {
  if (installed) return; installed = true;
  const handle = async (rows: any[]) => {
    if (process.env.NOTIFY_EMAIL !== 'true' || !cfgFromEnv()) return;
    for (const n of rows) {
      const e: any = await runSystem(() => M.Employee.unscoped().findByPk(n.userId, { attributes: ['id', 'email', 'name', 'status', 'companyId'] }));
      if (!e?.email || ['terminated', 'invited'].includes(e.status)) continue;
      queueMail({ to: e.email, kind: 'notification', companyId: e.companyId, subject: `AMS HRMS: ${String(n.title || 'New notification').slice(0, 150)}`,
        text: `Hello ${e.name},\n\nYou have a new notification in AMS HRMS: ${String(n.title || '').slice(0, 200)}\n\nSign in to read it: ${appBase()}\n` });
    }
  };
  (M.Notification as any).addHook('afterCreate', (n: any) => { handle([n]).catch(() => null); });
  (M.Notification as any).addHook('afterBulkCreate', (ns: any[]) => { handle(ns).catch(() => null); });
}