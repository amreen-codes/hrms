/** Scheduled jobs run once PER COMPANY so notifications and escalations never cross tenants. */
import { Op } from 'sequelize';
import * as M from './models';
import { runAs, runSystem } from './tenancy';
import { sweepLifecycle, runCredentialReminders } from './lifecycle';
import { applyDuePayChanges } from './compensation';
import { runUiJob, runInsuranceJob } from './uiInsurance';
import { runTrainingJob } from './training';
import { runComplianceJob } from './complianceFlow';
import { expireGracePeriods } from './billing';
import { purgeOldChats } from './ai';

export const forEachCompany = async (fn: (c: any) => Promise<any>) => {
  const cs: any[] = await runSystem(() => M.Company.findAll({ where: { status: 'active' } }));
  const out: any[] = [];
  for (const c of cs) { try { out.push({ companyId: c.id, ...(await runAs(c.id, () => fn(c))) }); } catch (e: any) { console.error(`job failed for company ${c.id}:`, e?.message); } }
  return out;
};
export async function runScheduledJobs() {
  const perCompany = await forEachCompany(async () => { await applyDuePayChanges(); return { lifecycle: await sweepLifecycle(), credentials: await runCredentialReminders(), ui: await runUiJob(), insurance: await runInsuranceJob(), training: await runTrainingJob(), compliance: await runComplianceJob() }; });
  await expireGracePeriods();
  await runSystem(() => purgeOldChats());
  await runSystem(() => M.Session.destroy({ where: { expiresAt: { [Op.lt]: new Date(Date.now() - 30 * 864e5) } } }));   // housekeeping
  return perCompany;
}
export function startJobs() {
  if (process.env.NODE_ENV === 'test') return;
  const tick = () => runScheduledJobs().catch((e) => console.error('scheduled jobs failed:', e?.message));
  tick(); setInterval(tick, 6 * 36e5).unref();
}