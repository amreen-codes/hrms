import 'dotenv/config';
import { QueryInterface } from 'sequelize';
import * as M from './models';
/**
 * Versioned, idempotent migrations (replaces "start once with DB_SYNC_ALTER=true" for existing databases).
 * Usage: npm run migrate. Applied names are recorded in schema_migrations.
 */
const migrations: { name: string; up: (qi: QueryInterface) => Promise<void> }[] = [
  // MUST stay first: older migrations call model.sync(), which adds a companyId index and so needs the column to exist on old databases.
  { name: '2026-11-19-multi-tenant-p14', async up(qi) {
    for (const model of M.P14_MODELS) await (model as any).sync();
    const q = (sql: string, replacements: any[] = []) => M.sequelize.query(sql, { replacements });
    const emp: any = await qi.describeTable('Employees').catch(() => null);
    if (emp) {
      const add: Record<string, string> = { inviteTokenHash: 'VARCHAR(64) NULL', inviteExpiresAt: 'DATETIME NULL', passwordChangedAt: 'DATETIME NULL' };
      for (const [c, t] of Object.entries(add)) if (!emp[c]) await q(`ALTER TABLE Employees ADD COLUMN ${c} ${t}`);
      await q("ALTER TABLE Employees MODIFY role ENUM('admin','hr','manager','employee','superadmin') NULL DEFAULT 'employee'");
      await q("ALTER TABLE Employees MODIFY status ENUM('onboarding','active','terminated','invited') NULL DEFAULT 'active'");
    }
    // Existing data all belongs to ONE default company; add companyId to every table and backfill it.
    const [rows]: any = emp ? await q('SELECT COUNT(*) AS n FROM Employees') : [[{ n: 0 }]];
    let defaultId: number | null = null;
    if (Number(rows[0].n) > 0) { const ex: any = await M.Company.findOne({ where: { slug: 'default' } }); defaultId = ex ? ex.id : ((await M.Company.create({ name: process.env.COMPANY_NAME || 'Default Company', slug: 'default', plan: 'enterprise', subState: 'active' } as any)) as any).id; }
    for (const model of Object.values(M.sequelize.models) as any[]) {
      if (model.name === 'Company') continue;
      const table = model.getTableName() as string, cols: any = await qi.describeTable(table).catch(() => null);
      if (!cols) continue;
      if (!cols.companyId) { await q(`ALTER TABLE \`${table}\` ADD COLUMN companyId INT NULL`); await model.sync(); /* Sequelize adds its own companyId index */ }
      if (defaultId) await q(`UPDATE \`${table}\` SET companyId = ? WHERE companyId IS NULL`, [defaultId]);
    }
  } },
  { name: '2026-11-17-lifecycle-p5-p7-p8', async up(qi) {
    const emp: any = await qi.describeTable('Employees').catch(() => null);
    if (emp && !emp.accessRevokedAt) await qi.addColumn('Employees', 'accessRevokedAt', { type: 'DATETIME', allowNull: true });
    for (const model of M.LIFECYCLE_MODELS) await (model as any).sync();   // CREATE TABLE IF NOT EXISTS (+ indexes)
  } },
  { name: '2026-11-18-recruitment-p6-s1-s3', async up(qi) {
    const cols: Record<string, string> = { email: 'VARCHAR(160)', phone: 'VARCHAR(40)', requisitionId: 'INT', source: 'VARCHAR(40)', resumeRef: 'VARCHAR(500)', workAuthorized: 'TINYINT(1)', needsSponsorship: 'TINYINT(1)',
      history: 'JSON', answers: 'JSON', screening: 'JSON', consentAt: 'DATETIME', duplicateOf: 'INT', rejectReason: 'VARCHAR(40)', rejectedAt: 'DATETIME', employeeId: 'INT', hiredAt: 'DATETIME' };
    const t: any = await qi.describeTable('Candidates').catch(() => null);
    if (t) {
      for (const [c, type] of Object.entries(cols)) if (!t[c]) await M.sequelize.query(`ALTER TABLE Candidates ADD COLUMN ${c} ${type} NULL`);
      await M.sequelize.query(`ALTER TABLE Candidates MODIFY stage ENUM(${M.STAGE_VALUES.map((x) => `'${x}'`).join(',')}) NOT NULL DEFAULT 'received'`);
    }
    for (const model of M.RECRUITMENT_MODELS) await (model as any).sync();
  } },
  { name: '2026-11-18-compensation-p9-p10-p17-p18', async up(qi) {
    const t: any = await qi.describeTable('PaySheets').catch(() => null);
    if (t) for (const c of ['commission', 'bonus']) if (!t[c]) await M.sequelize.query(`ALTER TABLE PaySheets ADD COLUMN ${c} DECIMAL(10,2) NOT NULL DEFAULT 0`);
    for (const model of M.COMP_MODELS) await (model as any).sync();
  } },
  { name: '2026-11-20-s6-offboarding-approval-s8-rules', async up(qi) {
    for (const model of M.S6_MODELS) await (model as any).sync();
    const q = (sql: string) => M.sequelize.query(sql);
    const cols: any = await qi.describeTable('Offboardings').catch(() => null);
    if (cols) {
      const add: Record<string, string> = { initiatedBy: "VARCHAR(10) NULL DEFAULT 'hr'", proposedBy: 'INT NULL', originalReason: 'VARCHAR(30) NULL', decidedBy: 'INT NULL', decisionNote: 'VARCHAR(1000) NULL' };
      for (const [c, t] of Object.entries(add)) if (!cols[c]) await q(`ALTER TABLE Offboardings ADD COLUMN ${c} ${t}`);
      await q("ALTER TABLE Offboardings MODIFY status ENUM('proposed','in_progress','complete','cancelled','rejected') NULL DEFAULT 'in_progress'");
      await q("UPDATE Offboardings SET originalReason = reason WHERE originalReason IS NULL");
      await q("UPDATE Offboardings SET decidedBy = startedBy WHERE decidedBy IS NULL AND status <> 'proposed'");
    }
  } },
  { name: '2026-11-21-p19-p16-p15', async up() { for (const model of M.P15_MODELS) await (model as any).sync(); } },
  { name: '2026-11-22-p20-p21-s7-a8', async up() { for (const model of M.P20_MODELS) await (model as any).sync(); } },
  { name: '2026-11-23-s4-s5-training-performance', async up() { for (const model of M.S4S5_MODELS) await (model as any).sync(); } },
  { name: '2026-11-24-p4-approval-p3-tasks', async up(qi) {
    for (const model of M.P4_MODELS) await (model as any).sync();
    const q = (sql: string) => M.sequelize.query(sql);
    const addCols = async (table: string, add: Record<string, string>) => { const cols: any = await qi.describeTable(table).catch(() => null); if (!cols) return false; for (const [c, t] of Object.entries(add)) if (!cols[c]) await q(`ALTER TABLE \`${table}\` ADD COLUMN ${c} ${t}`); return true; };
    if (await addCols('PaySheets', { version: 'INT NOT NULL DEFAULT 1', adjustment: 'DECIMAL(10,2) NOT NULL DEFAULT 0', reviewedBy: 'INT NULL', approvedBy: 'INT NULL', approvedAt: 'DATETIME NULL', lastAdjustedBy: 'INT NULL' }))
      await q("ALTER TABLE PaySheets MODIFY status ENUM('draft','reviewed','approved','locked','exported') NULL DEFAULT 'draft'");
    if (await addCols('ComplianceTasks', { ownerId: 'INT NULL', locationKey: 'VARCHAR(30) NULL', ruleId: 'INT NULL', source: 'VARCHAR(20) NULL', periodKey: 'VARCHAR(20) NULL', overdueNotifiedAt: 'DATETIME NULL', escalatedAt: 'DATETIME NULL', escalationLevel: 'INT NOT NULL DEFAULT 0', waivedBy: 'INT NULL', waiveReason: 'VARCHAR(1000) NULL' }))
      await q("ALTER TABLE ComplianceTasks MODIFY status ENUM('open','overdue','done','waived') NULL DEFAULT 'open'");
  } },
  { name: '2026-11-23-remove-mfa-must-change-password', async up(qi) {
    const q = (sql: string) => M.sequelize.query(sql);
    const emp: any = await qi.describeTable('Employees').catch(() => null);
    if (!emp) return;
    // New flag: an Admin-set or Admin-reset password must be changed at the next login. Existing users default to 0, so they keep signing in as before.
    if (!emp.mustChangePassword) await q('ALTER TABLE Employees ADD COLUMN mustChangePassword TINYINT(1) NOT NULL DEFAULT 0');
    // MFA is gone: erase stored authenticator secrets and recovery codes. The old columns are deliberately NOT dropped (no destructive schema change, nothing else is touched).
    const wipe = [['mfaEnabled', '0'], ['mfaSecretEnc', 'NULL'], ['mfaRecovery', 'NULL'], ['mfaLastStep', '0']].filter(([c]) => emp[c]).map(([c, v]) => `${c} = ${v}`);
    if (wipe.length) await q(`UPDATE Employees SET ${wipe.join(', ')}`);
  } },
  { name: '2026-11-24-stripe-email-ai', async up(qi) {
    const cols: any = await qi.describeTable('Companies').catch(() => null);
    if (cols) for (const [c, t] of Object.entries({ stripeCustomerId: 'VARCHAR(64) NULL', stripeSubscriptionId: 'VARCHAR(64) NULL', failedAt: 'DATETIME NULL' })) if (!cols[c]) await M.sequelize.query(`ALTER TABLE Companies ADD COLUMN ${c} ${t}`);
    for (const model of M.BILLING_MODELS) await (model as any).sync();
  } },
  { name: '2026-11-25-ai-chats', async up() { await (M.AiChat as any).sync(); } },
];
export async function migrate() {
  const qi = M.sequelize.getQueryInterface();
  await M.sequelize.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(160) PRIMARY KEY, appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const done = new Set(((await M.sequelize.query('SELECT name FROM schema_migrations', { type: 'SELECT' })) as any[]).map((r) => r.name)); const ran: string[] = [];
  for (const m of migrations) { if (done.has(m.name)) continue; await m.up(qi); await M.sequelize.query('INSERT INTO schema_migrations (name) VALUES (?)', { replacements: [m.name] }); ran.push(m.name); }
  return ran;
}
if (require.main === module) migrate().then((r) => { console.log(r.length ? 'Applied: ' + r.join(', ') : 'Database is up to date.'); process.exit(0); }).catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });