import { useState } from 'react';
import { api, useLoad, user } from './api';
import { Title, Table, Tag, Td } from './pages';
import { Field, Grid, Toggle } from './forms';

const $ = (c: any) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isHR = () => ['admin', 'hr'].includes(user().role), isStaff = () => user().role !== 'employee';
const month = () => new Date().toISOString().slice(0, 7), today = () => new Date().toISOString().slice(0, 10);

function useAct() {
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const run = async (fn: () => Promise<any>, ok = 'Saved') => { setMsg(null); try { const r = await fn(); setMsg({ ok: true, t: ok }); return r ?? true; } catch (e: any) { setMsg({ ok: false, t: e.message }); return null; } };
  const box = msg && <div role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'alert-ok' : 'alert-warn !border-red-200 !bg-red-50 !text-red-700'}>{msg.t}</div>;
  return { run, box };
}
const EmpSelect = ({ emps, value, onChange }: any) => (
  <select className="input" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose employee</option>{(emps || []).map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
);

// ---------------- P9 / P10 commission ----------------
function Commission({ emps }: any) {
  const [plans, lp] = useLoad('/commission/plans'), [sales, ls] = useLoad('/sales'), [lines, ll] = useLoad('/commission/lines'); const a = useAct();
  const [p, setP] = useState<any>({ employeeId: '', name: '', kind: 'flat', rate: '', cap: '', draw: '', tiers: [{ upTo: '', rate: '' }] });
  const [s, setS] = useState<any>({ employeeId: '', saleDate: today(), amount: '', splitPct: 100, description: '' }); const [period, setPeriod] = useState(month());
  const setTier = (i: number, k: string, v: string) => setP({ ...p, tiers: p.tiers.map((t: any, j: number) => (j === i ? { ...t, [k]: v } : t)) });
  const decide = async (id: number, approve: boolean) => { let comment = ''; if (!approve) { comment = window.prompt('Why are you returning this statement?') || ''; if (!comment) return; } await a.run(() => api(`/commission/lines/${id}/decide`, 'POST', { approve, comment }), approve ? 'Approved' : 'Returned'); ll(); };
  const refund = async (id: number) => { const v = window.prompt('Refund amount in dollars'); if (!v) return; await a.run(() => api(`/sales/${id}/refund`, 'POST', { refund: v }), 'Refund recorded. It becomes a negative line at the next calculation.'); ls(); };
  return (<div className="space-y-5">{a.box}
    {isHR() && <div className="card space-y-3"><h2 className="font-semibold">Assign commission plan (P9)</h2>
      <Grid><Field label="Employee"><EmpSelect emps={emps} value={p.employeeId} onChange={(v: string) => setP({ ...p, employeeId: v })} /></Field><Field label="Plan name"><input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <Field label="Type"><select className="input" value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value })}><option value="flat">Flat rate</option><option value="tiered">Tiered (marginal)</option></select></Field>
        {p.kind === 'flat' && <Field label="Rate (%)"><input className="input" type="number" min={0} max={100} step="0.01" value={p.rate} onChange={(e) => setP({ ...p, rate: e.target.value })} /></Field>}
        <Field label="Cap per period (USD, optional)"><input className="input" type="number" min={0} value={p.cap} onChange={(e) => setP({ ...p, cap: e.target.value })} /></Field>
        <Field label="Draw per period (USD, optional)" hint="Advance paid every period, recovered from later commission."><input className="input" type="number" min={0} value={p.draw} onChange={(e) => setP({ ...p, draw: e.target.value })} /></Field></Grid>
      {p.kind === 'tiered' && <div className="space-y-2"><div className="label">Tiers: sales up to (USD) and rate. Leave the last limit empty.</div>
        {p.tiers.map((t: any, i: number) => <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-2"><input className="input" type="number" placeholder="Up to (empty = no limit)" value={t.upTo} onChange={(e) => setTier(i, 'upTo', e.target.value)} />
          <input className="input" type="number" step="0.01" placeholder="Rate %" value={t.rate} onChange={(e) => setTier(i, 'rate', e.target.value)} /><button type="button" className="btn-ghost" onClick={() => setP({ ...p, tiers: p.tiers.filter((_: any, j: number) => j !== i) })}>Remove</button></div>)}
        <button type="button" className="btn-ghost" onClick={() => setP({ ...p, tiers: [...p.tiers, { upTo: '', rate: '' }] })}>Add tier</button></div>}
      <button className="btn" onClick={async () => { if (await a.run(() => api('/commission/plans', 'POST', p), 'Plan saved. Any earlier plan for this employee was ended.')) lp(); }}>Save plan</button></div>}
    <Table head={['Employee', 'Plan', 'Type', 'Rate', 'Cap', 'Draw', 'Active']}>{(plans || []).map((x: any) => <tr key={x.id}><Td>{x.employeeName}</Td><Td>{x.name}</Td><Td>{x.kind}</Td>
      <Td>{x.kind === 'flat' ? (Number(x.rate) * 100).toFixed(2) + '%' : (x.tiers || []).map((t: any) => `${t.upTo == null ? 'above' : '≤ ' + $(t.upTo)}: ${(t.rate * 100).toFixed(2)}%`).join(' · ')}</Td><Td>{x.capCents != null ? $(x.capCents) : '-'}</Td><Td>{$(x.drawCents)}</Td><Td><Tag s={x.active ? 'active' : 'ended'} /></Td></tr>)}</Table>
    <div className="card space-y-3"><h2 className="font-semibold">Record a sale</h2>
      <Grid>{isStaff() && <Field label="Employee"><EmpSelect emps={emps} value={s.employeeId} onChange={(v: string) => setS({ ...s, employeeId: v })} /></Field>}
        <Field label="Sale date"><input className="input" type="date" max={today()} value={s.saleDate} onChange={(e) => setS({ ...s, saleDate: e.target.value })} /></Field>
        <Field label="Amount (USD)"><input className="input" type="number" min={0} step="0.01" value={s.amount} onChange={(e) => setS({ ...s, amount: e.target.value })} /></Field>
        <Field label="Your share of the sale (%)"><input className="input" type="number" min={1} max={100} value={s.splitPct} onChange={(e) => setS({ ...s, splitPct: e.target.value })} /></Field>
        <Field label="Description" span={2}><input className="input" value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></Field></Grid>
      <button className="btn" onClick={async () => { if (await a.run(() => api('/sales', 'POST', { ...s, employeeId: s.employeeId || undefined }), 'Sale recorded')) ls(); }}>Save sale</button></div>
    <Table head={['Date', 'Employee', 'Description', 'Amount', 'Share', 'Refund', '']}>{(sales || []).map((x: any) => <tr key={x.id}><Td>{x.saleDate}</Td><Td>{x.employeeName}</Td><Td>{x.description}</Td><Td>{$(x.amountCents)}</Td><Td>{x.splitPct}%</Td><Td>{x.refundCents ? $(x.refundCents) : ''}</Td>
      <Td>{isHR() && !x.refundCents && <button className="btn-ghost !py-1" onClick={() => refund(x.id)}>Refund</button>}</Td></tr>)}</Table>
    <div className="flex flex-wrap items-end justify-between gap-3"><h2 className="font-semibold">Commission statements (feed payroll)</h2>
      {isHR() && <div className="flex items-end gap-2"><input className="input !w-36" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /><button className="btn" onClick={async () => { const r = await a.run(() => api('/commission/calculate', 'POST', { period }), 'Calculated'); if (r) ll(); }}>Calculate month</button></div>}</div>
    <Table head={['Month', 'Employee', 'Sales credited', 'Earned', 'Draw', 'Extra', 'Refund clawback', 'Carried shortfall', 'To pay', 'Status', '']}>{(lines || []).map((x: any) => <tr key={x.id}><Td>{x.period}</Td><Td>{x.employeeName}</Td><Td>{$(x.creditedCents)}</Td><Td>{$(x.earnedCents)}</Td><Td>{$(x.drawCents)}</Td><Td>{$(x.extraCents)}</Td><Td>{$(x.clawbackCents)}</Td><Td>{$(x.shortfallCents)}</Td><Td><b>{$(x.payableCents)}</b></Td><Td><Tag s={x.status} /></Td>
      <Td>{isStaff() && x.status === 'draft' && <span className="flex gap-1"><button className="btn !px-2 !py-1" onClick={() => decide(x.id, true)}>Approve</button><button className="btn-ghost !px-2 !py-1" onClick={() => decide(x.id, false)}>Return</button></span>}</Td></tr>)}</Table></div>);
}

// ---------------- P18 bonuses ----------------
function Bonuses({ emps }: any) {
  const [rows, load] = useLoad('/bonuses'); const a = useAct();
  const [f, setF] = useState<any>({ employeeId: '', kind: 'spot', amount: '', payPeriod: month(), discretionary: true, agreementOnFile: false, windowMonths: 12, reason: '' });
  const decide = async (id: number, approve: boolean) => { let comment = ''; if (!approve) { comment = window.prompt('Why is it rejected?') || ''; if (!comment) return; } await a.run(() => api(`/bonuses/${id}/decide`, 'POST', { approve, comment }), approve ? 'Approved. Withholding calculated.' : 'Rejected'); load(); };
  const claw = async (id: number) => { const reason = window.prompt('Reason for recovering this bonus'); if (!reason) return; const restricted = window.confirm('Does this state limit deductions from wages?\nOK = yes (collect by invoice). Cancel = no (payroll deduction).'); const r = await a.run(() => api(`/bonuses/${id}/clawback`, 'POST', { reason, stateRestrictsDeduction: restricted }), 'Clawback recorded'); if (r) load(); };
  return (<div className="space-y-5">{a.box}
    {isStaff() && <div className="card space-y-3"><h2 className="font-semibold">Propose a bonus</h2>
      <Grid><Field label="Employee"><EmpSelect emps={emps} value={f.employeeId} onChange={(v: string) => setF({ ...f, employeeId: v })} /></Field>
        <Field label="Type"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['annual', 'spot', 'signing', 'retention', 'referral'].map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Amount (USD)"><input className="input" type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Pay in month"><input className="input" type="month" value={f.payPeriod} onChange={(e) => setF({ ...f, payPeriod: e.target.value })} /></Field>
        <Field label="Clawback window (months)"><input className="input" type="number" min={0} max={60} value={f.windowMonths} onChange={(e) => setF({ ...f, windowMonths: e.target.value })} /></Field>
        <Field label="Reason" span={2}><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></Grid>
      <div className="flex flex-wrap gap-6"><Toggle on={f.discretionary} set={(v: boolean) => setF({ ...f, discretionary: v })} label="Discretionary (not promised or formula based)" /><Toggle on={f.agreementOnFile} set={(v: boolean) => setF({ ...f, agreementOnFile: v })} label="Signed clawback agreement on file" /></div>
      {!f.discretionary && <p className="hint">Non-discretionary bonuses are added to the overtime regular rate for non-exempt staff.</p>}
      <button className="btn" onClick={async () => { if (await a.run(() => api('/bonuses', 'POST', f), 'Bonus proposed. Another HR user must approve it.')) load(); }}>Propose</button></div>}
    <Table head={['Employee', 'Type', 'Amount', 'Month', 'Kind', 'Withholding (22% / 37%)', 'Status', '']}>{(rows || []).map((x: any) => <tr key={x.id}><Td>{x.employeeName}</Td><Td className="capitalize">{x.kind}</Td><Td>{$(x.amountCents)}</Td><Td>{x.payPeriod}</Td><Td>{x.discretionary ? 'discretionary' : 'non-discretionary'}</Td><Td>{x.status === 'proposed' ? '' : $(x.withholdingCents)}</Td><Td><Tag s={x.status} /></Td>
      <Td>{isHR() && x.status === 'proposed' && <span className="flex gap-1"><button className="btn !px-2 !py-1" onClick={() => decide(x.id, true)}>Approve</button><button className="btn-ghost !px-2 !py-1" onClick={() => decide(x.id, false)}>Reject</button></span>}{isHR() && x.status === 'paid' && <button className="btn-ghost !py-1" onClick={() => claw(x.id)}>Recover</button>}</Td></tr>)}</Table></div>);
}

// ---------------- P17 pay changes ----------------
function PayChanges({ emps }: any) {
  const [rows, load] = useLoad('/pay-changes'); const a = useAct();
  const [f, setF] = useState<any>({ employeeId: '', payType: 'hourly', hourlyRate: '', annualSalary: '', flsaExempt: false, effectiveDate: today(), reason: '', bandMin: '', bandMax: '' });
  const decide = async (id: number, approve: boolean) => { let comment = ''; if (approve) { if (!window.confirm('Is this change inside the approved budget?')) return; } else { comment = window.prompt('Why is it rejected?') || ''; if (!comment) return; } await a.run(() => api(`/pay-changes/${id}/decide`, 'POST', { approve, comment, budgetApproved: approve }), approve ? 'Approved' : 'Rejected'); load(); };
  return (<div className="space-y-5">{a.box}
    {isStaff() && <div className="card space-y-3"><h2 className="font-semibold">Propose a pay change</h2>
      <Grid><Field label="Employee"><EmpSelect emps={emps} value={f.employeeId} onChange={(v: string) => setF({ ...f, employeeId: v })} /></Field>
        <Field label="Pay type"><select className="input" value={f.payType} onChange={(e) => setF({ ...f, payType: e.target.value, flsaExempt: e.target.value === 'salary' ? f.flsaExempt : false })}><option value="hourly">Hourly</option><option value="salary">Salary</option></select></Field>
        {f.payType === 'hourly' ? <Field label="Hourly rate (USD)"><input className="input" type="number" min={0} step="0.01" value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: e.target.value })} /></Field>
          : <Field label="Annual salary (USD)"><input className="input" type="number" min={0} value={f.annualSalary} onChange={(e) => setF({ ...f, annualSalary: e.target.value })} /></Field>}
        <Field label="Effective date"><input className="input" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field>
        <Field label="Pay band minimum (annual, optional)"><input className="input" type="number" min={0} value={f.bandMin} onChange={(e) => setF({ ...f, bandMin: e.target.value })} /></Field><Field label="Pay band maximum (annual, optional)"><input className="input" type="number" min={0} value={f.bandMax} onChange={(e) => setF({ ...f, bandMax: e.target.value })} /></Field>
        <Field label="Reason" span={2}><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Promotion, annual review, market adjustment" /></Field></Grid>
      {f.payType === 'salary' && <Toggle on={f.flsaExempt} set={(v: boolean) => setF({ ...f, flsaExempt: v })} label="Exempt from overtime (salary floor for the work state is checked)" />}
      <button className="btn" onClick={async () => { if (await a.run(() => api('/pay-changes', 'POST', f), 'Proposed. HR approval is next.')) load(); }}>Propose</button></div>}
    <Table head={['Employee', 'New pay', 'Exempt', 'Effective', 'Reason', 'Warnings', 'Status', '']}>{(rows || []).map((x: any) => <tr key={x.id}><Td>{x.employeeName}</Td><Td>{x.payType === 'hourly' ? $(x.hourlyCents) + '/h' : $(x.annualCents) + '/yr'}</Td><Td>{x.flsaExempt ? 'yes' : 'no'}</Td><Td>{x.effectiveDate}</Td><Td>{x.reason}</Td><Td>{(x.warnings || []).join(' · ')}</Td><Td><Tag s={x.status === 'approved' && x.applied ? 'active' : x.status} /></Td>
      <Td>{isHR() && x.status === 'pending' && <span className="flex gap-1"><button className="btn !px-2 !py-1" onClick={() => decide(x.id, true)}>Approve</button><button className="btn-ghost !px-2 !py-1" onClick={() => decide(x.id, false)}>Reject</button></span>}</Td></tr>)}</Table></div>);
}

export function Compensation() {
  const [tab, setTab] = useState<'commission' | 'bonuses' | 'pay'>('commission'); const [emps] = useLoad('/employees');
  const tabs: [string, string][] = [['commission', 'Commission'], ['bonuses', 'Bonuses'], ['pay', 'Pay changes']];
  return (<div className="space-y-5"><Title>Compensation</Title>
    <div role="tablist" className="flex gap-1 rounded-xl bg-slate-100 p-1">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k as any)} className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${tab === k ? 'bg-white shadow-soft' : 'text-slate-500 hover:text-slate-800'}`}>{l}</button>)}</div>
    {tab === 'commission' ? <Commission emps={emps} /> : tab === 'bonuses' ? <Bonuses emps={emps} /> : <PayChanges emps={emps} />}</div>);
}
