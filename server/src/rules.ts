/** S8: versioned compliance rules by jurisdiction + effective date. Never edited in place: a change is a new version (audit trail). */
import { Router } from 'express';
import { Op } from 'sequelize';
import * as M from './models';
import { log } from './services';
import { wrap, bad, hr } from './http';
import * as H from './hrCore';
import { isoDate } from './lifecycleCore';

export const rulesRouter = Router();
const KEY = /^[a-z][a-z_]{2,39}$/, JUR = /^(US|[A-Z]{2}(:[A-Za-z .'-]{2,40})?)$/;   // US, CA, or CA:Los Angeles
function validateValue(key: string, v: any) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('value must be an object');
  if (key === 'final_pay') {
    if (typeof v.payoutAccruedLeave !== 'boolean' || typeof v.payoutSick !== 'boolean') throw bad('final_pay needs payoutAccruedLeave and payoutSick (true/false)');
    if (typeof v.deadline !== 'string' || !v.deadline.trim() || v.deadline.length > 300) throw bad('final_pay needs a deadline description (max 300 characters)');
  }
  if (key.startsWith('task_')) {
    if (typeof v.type !== 'string' || !v.type.trim() || v.type.length > 120) throw bad('A task rule needs a type (the task name, max 120 characters)');
    if (!['hire', 'annual'].includes(v.trigger)) throw bad('trigger must be hire or annual (training and credential tasks come from their own modules)');
    if (!Number.isInteger(v.dueDays) || v.dueDays < 1 || v.dueDays > 365) throw bad('dueDays must be a whole number from 1 to 365');
    if (v.retentionYears !== undefined && !(Number.isInteger(v.retentionYears) && v.retentionYears >= 0 && v.retentionYears <= 99)) throw bad('retentionYears must be 0 to 99');
  }
  if (JSON.stringify(v).length > 5000) throw bad('value is too large');
}
rulesRouter.get('/compliance-rules', hr, wrap(async (q, s) => {
  const where: any = {}; if (q.query.key) where.key = String(q.query.key); if (q.query.jurisdiction) where.jurisdiction = String(q.query.jurisdiction);
  s.json(await M.ComplianceRule.findAll({ where, order: [['key', 'ASC'], ['jurisdiction', 'ASC'], ['version', 'DESC']], limit: 500 }));
}));
rulesRouter.get('/compliance-rules/effective', hr, wrap(async (q, s) => {
  const key = String(q.query.key || ''), date = isoDate(String(q.query.date || '')) || new Date().toISOString().slice(0, 10);
  const js = String(q.query.jurisdictions || 'US').split(',').map((x) => x.trim()).filter(Boolean);
  if (!KEY.test(key)) throw bad('key is required');
  s.json(H.ruleAt((await M.ComplianceRule.findAll({ where: { key }, raw: true })) as any, key, js, date));   // first jurisdiction wins (put the most specific first)
}));
rulesRouter.post('/compliance-rules', hr, wrap(async (q, s) => {
  const b = q.body, key = String(b.key || ''), jurisdiction = String(b.jurisdiction || ''), eff = isoDate(b.effectiveDate);
  if (!KEY.test(key)) throw bad('key must be lowercase letters and underscores'); if (!JUR.test(jurisdiction)) throw bad('jurisdiction must look like US, CA or CA:Los Angeles');
  if (!eff) throw bad('Enter a valid effective date'); validateValue(key, b.value);
  const last: any = await M.ComplianceRule.findOne({ where: { key, jurisdiction }, order: [['version', 'DESC']] });
  const r: any = await M.ComplianceRule.create({ key, jurisdiction, effectiveDate: eff, version: (last?.version || 0) + 1, value: b.value, sourceUrl: String(b.sourceUrl || '').slice(0, 500), legalOwner: String(b.legalOwner || '').slice(0, 120), verified: !!b.verified, createdBy: q.user.id } as any);
  await log(q.user.id, 'Compliance Rule Added', `${key} ${jurisdiction} v${r.version} effective ${eff}`); s.status(201).json(r);
}));
