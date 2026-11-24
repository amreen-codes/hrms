import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9';
const now = new Date(); const CUR = now.toISOString().slice(0, 7);
const prev = new Date(now); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1); const PERIOD = prev.toISOString().slice(0, 7);
const today = now.toISOString().slice(0, 10), tomorrow = new Date(+now + 864e5).toISOString().slice(0, 10);
let id: Record<string, number> = {}; const tok: Record<string, string> = {};
const mk = (name: string, role: string, extra: any = {}) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active', ...extra }) as any;
const as = (n: string) => ({ Authorization: 'Bearer ' + tok[n.toLowerCase()] });
const post = (n: string, url: string, body: any = {}) => request(app).post('/api/' + url).set(as(n)).send(body);
const get = (n: string, url: string) => request(app).get('/api/' + url).set(as(n));

beforeAll(async () => {
  await M.sequelize.sync({ force: true });
  const ada: any = await mk('Ada', 'admin'), hana: any = await mk('Hana', 'hr'), hugo: any = await mk('Hugo', 'hr'), mia: any = await mk('Mia', 'manager'), olga: any = await mk('Olga', 'manager');
  const eli: any = await mk('Eli', 'employee', { managerId: mia.id, hourlyRate: 20, workState: 'TX' }), omar: any = await mk('Omar', 'employee', { hourlyRate: 20 });
  const cara: any = await mk('Cara', 'employee', { managerId: mia.id, workState: 'CA', payType: 'salary', annualSalary: 90000 });
  id = { hana: hana.id, hugo: hugo.id, mia: mia.id, olga: olga.id, eli: eli.id, omar: omar.id, cara: cara.id };
  for (const n of ['Ada', 'Hana', 'Hugo', 'Mia', 'Olga', 'Eli', 'Omar', 'Cara'])
    tok[n.toLowerCase()] = (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token;
});

describe('P9 commission plan, sales, calculation, approval', () => {
  let saleA: number, lineId: number;
  it('only HR assigns plans; invalid plans are refused', async () => {
    await post('mia', 'commission/plans', { employeeId: id.eli, name: 'x', kind: 'flat', rate: 10 }).expect(403);
    await post('hana', 'commission/plans', { employeeId: id.eli, name: 'Bad', kind: 'flat', rate: 150 }).expect(400);
    await post('hana', 'commission/plans', { employeeId: id.eli, name: 'Bad tiers', kind: 'tiered', tiers: [{ upTo: 1000, rate: 5 }] }).expect(400);   // last tier must be open-ended
    await post('hana', 'commission/plans', { employeeId: id.eli, name: 'Flat 10%', kind: 'flat', rate: 10 }).expect(200);
  });
  it('records sales with validation and scope', async () => {
    saleA = (await post('eli', 'sales', { saleDate: `${PERIOD}-10`, amount: 10000, description: 'Big deal' }).expect(200)).body.id;
    await post('eli', 'sales', { saleDate: `${PERIOD}-12`, amount: 2000, splitPct: 50, description: 'Shared deal' }).expect(200);
    await post('eli', 'sales', { saleDate: '2999-01-01', amount: 100, description: 'Future' }).expect(400);
    await post('eli', 'sales', { saleDate: `${PERIOD}-10`, amount: -5, description: 'Negative' }).expect(400);
    await post('omar', 'sales', { saleDate: `${PERIOD}-10`, amount: 100, description: 'No plan' }).expect(400);
    await post('olga', 'sales', { employeeId: id.eli, saleDate: `${PERIOD}-10`, amount: 100, description: 'Not my team' }).expect(403);
    expect((await get('eli', 'sales').expect(200)).body.length).toBe(2);
    expect((await get('omar', 'sales').expect(200)).body.length).toBe(0);
  });
  it('calculates the month: 10% of $11,000 credited = $1,100', async () => {
    await post('mia', 'commission/calculate', { period: PERIOD }).expect(403);
    await post('hana', 'commission/calculate', { period: 'nope' }).expect(400);
    expect((await post('hana', 'commission/calculate', { period: PERIOD }).expect(200)).body.lines).toBe(1);
    const l = (await get('hana', 'commission/lines').expect(200)).body[0]; lineId = l.id;
    expect([l.creditedCents, l.earnedCents, l.payableCents, l.status]).toEqual([1100000, 110000, 110000, 'draft']);
  });
  it('approval rules: team manager only, never self, return needs a comment', async () => {
    await post('eli', `commission/lines/${lineId}/decide`, { approve: true }).expect(403);
    await post('olga', `commission/lines/${lineId}/decide`, { approve: true }).expect(403);
    await post('mia', `commission/lines/${lineId}/decide`, { approve: false }).expect(400);
    await post('mia', `commission/lines/${lineId}/decide`, { approve: false, comment: 'Check the split' }).expect(200);
    await post('hana', 'commission/calculate', { period: PERIOD }).expect(200);                 // recalculated after return
    await post('mia', `commission/lines/${lineId}/decide`, { approve: true }).expect(200);
    await post('mia', `commission/lines/${lineId}/decide`, { approve: true }).expect(400);      // already decided
    await post('eli', 'sales', { saleDate: `${PERIOD}-20`, amount: 100, description: 'Late entry' }).expect(400);   // month is approved
    expect((await get('omar', 'commission/lines').expect(200)).body.length).toBe(0);
  });

  describe('P10 combined pay sheet and lock', () => {
    it('payroll adds approved commission to the base pay, exports it and locks the line', async () => {
      await M.Timesheet.create({ employeeId: id.eli, periodStart: `${PERIOD}-01`, periodEnd: `${PERIOD}-07`, status: 'approved', regularHours: 40, otHours: 0, dtHours: 0, payrollStatus: 'ready' } as any);
      await post('eli', 'payroll/generate', { period: PERIOD }).expect(403);
      expect((await post('hana', 'payroll/generate', { period: PERIOD }).expect(200)).body.sheets).toBe(1);
      const sheet: any = await M.PaySheet.findOne({ where: { employeeId: id.eli, period: PERIOD } });
      expect([Number(sheet.commission), Number(sheet.bonus), Number(sheet.gross)]).toEqual([1100, 0, 800 + 1100]);
      await post('hana', 'payroll/review', { period: PERIOD }).expect(200); await post('ada', 'payroll/approve', { period: PERIOD }).expect(200);
      await post('hana', 'payroll/lock', { period: PERIOD }).expect(200);
      expect((await M.CommissionLine.findByPk(lineId) as any).status).toBe('locked');
      const ex = await request(app).get(`/api/payroll/export?period=${PERIOD}`).set(as('hana')).expect(200);
      expect(ex.text.split('\n')[0]).toContain('commission,bonus'); expect(ex.text).toContain('1100');
      expect(ex.headers['x-file-sha256']).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('refund -> negative line next calculation', () => {
    it('HR records a refund; the next month gets a clawback line', async () => {
      await post('mia', `sales/${saleA}/refund`, { refund: 5000 }).expect(403);
      await post('hana', `sales/${saleA}/refund`, { refund: 999999 }).expect(400);
      await post('hana', `sales/${saleA}/refund`, { refund: 5000 }).expect(200);
      await post('hana', 'commission/calculate', { period: CUR }).expect(200);
      const l = (await get('hana', 'commission/lines').expect(200)).body.find((x: any) => x.period === CUR);
      expect(l.clawbackCents).toBe(-50000); expect(l.payableCents).toBe(-50000);
      const old = await M.CommissionLine.findOne({ where: { employeeId: id.eli, period: PERIOD } }) as any; expect(old.status).toBe('locked');   // locked month untouched
    });
  });
});

describe('P18 bonuses', () => {
  let bid: number;
  it('proposal rules', async () => {
    const body = { employeeId: id.eli, kind: 'spot', amount: 1000, payPeriod: CUR, reason: 'Great quarter', discretionary: false };
    await post('eli', 'bonuses', body).expect(403);
    await post('olga', 'bonuses', body).expect(403);
    await post('mia', 'bonuses', { ...body, employeeId: id.mia }).expect(403);
    await post('mia', 'bonuses', { ...body, kind: 'weird' }).expect(400);
    await post('mia', 'bonuses', { ...body, amount: 0 }).expect(400);
    bid = (await post('mia', 'bonuses', body).expect(200)).body.id;
  });
  it('a different HR user approves; supplemental withholding is 22%', async () => {
    await post('mia', `bonuses/${bid}/decide`, { approve: true }).expect(403);                      // managers cannot approve
    const mine = (await post('hana', 'bonuses', { employeeId: id.omar, kind: 'spot', amount: 50, payPeriod: CUR, reason: 'Own proposal' }).expect(200)).body.id;
    await post('hana', `bonuses/${mine}/decide`, { approve: true }).expect(403);                   // maker-checker
    await post('hugo', `bonuses/${bid}/decide`, { approve: false }).expect(400);
    const d = (await post('hugo', `bonuses/${bid}/decide`, { approve: true }).expect(200)).body;
    expect([d.status, d.withholdingCents]).toEqual(['approved', 22000]);
    await post('hana', `bonuses/${bid}/decide`, { approve: true }).expect(400);
  });
  it('payroll pays the bonus on a separate column, withholds and marks it paid on lock', async () => {
    const line: any = await M.CommissionLine.findOne({ where: { employeeId: id.eli, period: CUR } }); await line.update({ status: 'approved' });
    expect((await post('hana', 'payroll/generate', { period: CUR }).expect(200)).body.sheets).toBeGreaterThan(0);
    const s: any = await M.PaySheet.findOne({ where: { employeeId: id.eli, period: CUR } });
    expect([Number(s.commission), Number(s.bonus), Number(s.gross)]).toEqual([-500, 1000, 500]);
    expect(Number(s.deductions)).toBe(Math.round((500 * 0.0765 + 220) * 100) / 100);
    await post('hana', 'payroll/review', { period: CUR }).expect(200); await post('ada', 'payroll/approve', { period: CUR }).expect(200);
    await post('hana', 'payroll/lock', { period: CUR }).expect(200);
    expect(((await M.Bonus.findByPk(bid)) as any).status).toBe('paid');
  });
  it('clawback needs a signed agreement and the window; deduction-restricted states use an invoice', async () => {
    await post('hana', `bonuses/${bid}/clawback`, { reason: 'Left early' }).expect(400);           // no agreement on file
    const mkPaid = (extra: any) => M.Bonus.create({ employeeId: id.eli, kind: 'signing', amountCents: 100000, discretionary: true, reason: 'x', payPeriod: CUR, proposedBy: id.mia, status: 'paid', paidAt: today, clawbackWindowMonths: 12, ...extra } as any) as any;
    const ok: any = await mkPaid({ agreementOnFile: true });
    expect((await post('hana', `bonuses/${ok.id}/clawback`, { reason: 'Left within 3 months' }).expect(200)).body.method).toBe('payroll_deduction');
    const restricted: any = await mkPaid({ agreementOnFile: true });
    expect((await post('hana', `bonuses/${restricted.id}/clawback`, { reason: 'Left early', stateRestrictsDeduction: true }).expect(200)).body.method).toBe('invoice');
    const expired: any = await mkPaid({ agreementOnFile: true, clawbackWindowMonths: 0, paidAt: '2020-01-01' });
    await post('hana', `bonuses/${expired.id}/clawback`, { reason: 'Too late' }).expect(400);
    expect((await get('omar', 'bonuses').expect(200)).body.every((b: any) => b.employeeId === id.omar)).toBe(true);   // never Eli's bonuses
  });
});

describe('P17 pay changes', () => {
  let pcId: number;
  it('exempt salary below the California floor is refused; exempt must be salaried; no self-proposals', async () => {
    const b = { employeeId: id.cara, payType: 'salary', flsaExempt: true, effectiveDate: today, reason: 'Promotion' };
    await post('mia', 'pay-changes', { ...b, annualSalary: 50000 }).expect(400);
    await post('mia', 'pay-changes', { ...b, payType: 'hourly', hourlyRate: 40 }).expect(400);
    await post('mia', 'pay-changes', { ...b, employeeId: id.mia, annualSalary: 90000 }).expect(403);
    await post('olga', 'pay-changes', { ...b, annualSalary: 90000 }).expect(403);
    pcId = (await post('mia', 'pay-changes', { ...b, annualSalary: 80000 }).expect(200)).body.id;
  });
  it('another HR user approves after confirming the budget; the change is applied and the old pay kept', async () => {
    await post('mia', `pay-changes/${pcId}/decide`, { approve: true, budgetApproved: true }).expect(403);
    await post('hana', `pay-changes/${pcId}/decide`, { approve: true }).expect(400);                // budget not confirmed
    await post('hana', `pay-changes/${pcId}/decide`, { approve: true, budgetApproved: true }).expect(200);
    const e: any = await M.Employee.findByPk(id.cara); expect([e.payType, Number(e.annualSalary), !!e.flsaExempt]).toEqual(['salary', 80000, true]);
    const c: any = await M.PayChange.findByPk(pcId); expect(Number(c.oldPay.annualSalary)).toBe(90000);
    await post('hugo', `pay-changes/${pcId}/decide`, { approve: true, budgetApproved: true }).expect(400);   // already decided
  });
  it('a future-dated change waits for its effective date; a proposer cannot approve their own', async () => {
    const r = (await post('hana', 'pay-changes', { employeeId: id.eli, payType: 'hourly', hourlyRate: 25, effectiveDate: tomorrow, reason: 'Review' }).expect(200)).body;
    await post('hana', `pay-changes/${r.id}/decide`, { approve: true, budgetApproved: true }).expect(403);
    await post('hugo', `pay-changes/${r.id}/decide`, { approve: true, budgetApproved: true }).expect(200);
    expect(Number(((await M.Employee.findByPk(id.eli)) as any).hourlyRate)).toBe(20);               // not yet
    expect((await get('omar', 'pay-changes').expect(200)).body.length).toBe(0);
  });
});
