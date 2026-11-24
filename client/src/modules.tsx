import { useState } from 'react';
import { HeartPulse, ShieldCheck, Stethoscope, Plus } from 'lucide-react';
import { api, useLoad, user } from './api';
import { Title, Table, Tag, Td } from './pages';
import { Field, Grid } from './forms';

const money = (n: any) => '$' + Number(n).toFixed(2);
const isHR = () => ['admin', 'hr'].includes(user().role);

// ---------- P15 Benefits ----------
export function Benefits() {
  const [plans] = useLoad('/benefits/plans'); const [rows, load] = useLoad('/benefits');
  const [f, setF] = useState<any>({ plan: 'medical', coverage: 'employee', effectiveDate: '', deps: [] }); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const pl = (plans || []).find((p: any) => p.code === f.plan); const total = pl ? pl.cost[f.coverage] : 0; const mine = total * (1 - (pl?.employerPct || 0) / 100);
  const needDeps = ['spouse', 'children', 'family'].includes(f.coverage);
  const submit = async (waive = false) => { setErr(''); setMsg('');
    try { await api('/benefits', 'POST', { plan: f.plan, coverage: f.coverage, effectiveDate: f.effectiveDate, dependents: f.deps.filter((d: any) => d.name), waive }); setMsg(waive ? 'Plan waived.' : 'Enrollment submitted.'); setF({ ...f, deps: [] }); load(); } catch (x: any) { setErr(x.message); } };
  const verify = async (id: number, valid: boolean) => { await api(`/benefits/${id}/verify`, 'POST', { valid, comment: valid ? '' : 'Documents not valid' }); load(); };
  const name = (c: string) => (plans || []).find((p: any) => p.code === c)?.name || c;
  return (<div className="space-y-5"><Title>Employee Benefits</Title>
    <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
      <div className="card space-y-4"><h2 className="flex items-center gap-2 font-semibold"><HeartPulse size={18} className="text-brand" />Enroll or waive a plan</h2>
        <Grid><Field label="Plan"><select className="input" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{(plans || []).map((p: any) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
          <Field label="Coverage level"><select className="input" value={f.coverage} onChange={(e) => setF({ ...f, coverage: e.target.value })}><option value="employee">Employee only</option><option value="spouse">Employee + spouse</option><option value="children">Employee + children</option><option value="family">Family</option></select></Field>
          <Field label="Effective date" hint="Leave empty for the first allowed date (30-day waiting period)."><input className="input" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field></Grid>
        {needDeps && <div><div className="mb-2 flex items-center justify-between text-sm font-semibold">Dependents <button className="btn-ghost !py-1" onClick={() => setF({ ...f, deps: [...f.deps, { name: '', relation: 'child' }] })}><Plus size={14} />Add</button></div>
          {f.deps.map((d: any, i: number) => <div key={i} className="mb-2 grid grid-cols-[1fr_8rem] gap-2"><input className="input" placeholder="Full name" value={d.name} onChange={(e) => setF({ ...f, deps: f.deps.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <select className="input" value={d.relation} onChange={(e) => setF({ ...f, deps: f.deps.map((x: any, j: number) => (j === i ? { ...x, relation: e.target.value } : x)) })}><option>spouse</option><option>child</option><option>partner</option></select></div>)}
          <p className="hint">HR verifies dependents before coverage becomes active.</p></div>}
        {pl && <div className="alert-ok">Monthly cost: total <b>{money(total)}</b> · you pay <b>{money(mine)}</b> ({pl.preTax ? 'pre-tax' : 'post-tax'}) · employer pays {pl.employerPct}%</div>}
        {err && <p className="alert-warn">{err}</p>}{msg && <p className="alert-ok">{msg}</p>}
        <div className="flex gap-2"><button className="btn" onClick={() => submit(false)}>Enroll</button><button className="btn-ghost" onClick={() => submit(true)}>Waive this plan</button></div></div>
      <div className="card space-y-2 text-sm"><h2 className="flex items-center gap-2 font-semibold"><ShieldCheck size={18} className="text-brand" />How it works</h2>
        <p>1. Eligibility: scheduled hours and a 30-day waiting period.</p><p>2. Enroll, or waive. Waiving is recorded.</p><p>3. Dependents are verified by HR.</p><p>4. Your share is added to the pay sheet (P4).</p>
        <p className="hint">Marriage, birth, adoption or loss of other coverage reopen enrollment, usually for 30 days.</p></div></div>
    <Table head={['Employee', 'Plan', 'Coverage', 'Starts', 'You pay / month', 'Employer / month', 'Status', '']}>
      {(rows || []).map((b: any) => (<tr key={b.id}><Td>#{b.employeeId}</Td><Td>{name(b.plan)}</Td><Td className="capitalize">{b.coverage}</Td><Td>{b.effectiveDate}</Td><Td>{money(b.monthlyEmployee)}</Td><Td>{money(b.monthlyEmployer)}</Td><Td><Tag s={b.status} /></Td>
        <Td>{isHR() && b.status === 'pending_docs' && <span className="flex gap-1"><button className="btn !px-2 !py-1" onClick={() => verify(b.id, true)}>Verify</button><button className="btn-ghost !px-2 !py-1" onClick={() => verify(b.id, false)}>Reject</button></span>}</Td></tr>))}
    </Table></div>);
}

// ---------- P16 Paid Sick Leave ----------
export function SickLeave() {
  const [d, load] = useLoad('/sick/summary'); const [f, setF] = useState<any>({ reason: 'Own illness or injury', startDate: '', endDate: '', hours: 8 }); const [res, setRes] = useState<any>(null); const [err, setErr] = useState('');
  if (!d || !d.rule) return <p className="text-slate-500">Loading...</p>;
  const b = d.balance || { total: 0, used: 0, pending: 0 }; const left = b.total - b.used - b.pending; const pct = b.total ? Math.round((b.used + b.pending) / b.total * 100) : 0;
  const send = async () => { setErr(''); setRes(null); if (!f.startDate || !f.endDate) return setErr('Choose start and end dates'); try { setRes(await api('/leave', 'POST', { ...f, type: 'Sick', hours: Number(f.hours) })); load(); } catch (x: any) { setErr(x.message); } };
  const r = d.rule;
  return (<div className="space-y-5"><Title>Paid Sick Leave</Title>
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="card"><div className="label">Your balance</div><div className="font-serif text-4xl text-navy-800">{left} <span className="text-base text-slate-500">hours left</span></div>
        <div className="mt-3 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-gradient-to-r from-brand to-indigo-400" style={{ width: pct + '%' }} /></div><p className="hint">{b.used} used · {b.pending} pending · {b.total} per year</p></div>
      <div className="card lg:col-span-2"><div className="label">Rule set for {r.state} {r.mandated ? '(state law)' : '(company policy)'}</div>
        <div className="grid gap-2 text-sm sm:grid-cols-2"><div>Accrual: <b>{r.accrual}</b></div><div>Annual hours: <b>{r.annualHours}</b></div><div>Carryover: <b>{r.carryover}</b></div><div>Waiting period: <b>{r.waitingDays} days</b></div></div><p className={`mt-3 ${r.mandated ? 'alert-ok' : 'alert-warn'}`}>{r.note}</p></div></div>
    <div className="card space-y-4"><h2 className="flex items-center gap-2 font-semibold"><Stethoscope size={18} className="text-brand" />Request sick leave</h2>
      <Grid><Field label="Reason" span={2}><select className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{r.reasons.map((x: string) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="From"><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field><Field label="To"><input className="input" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Total hours" hint="Same pay rate as regular hours. No medical details needed."><input className="input" type="number" min={1} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field></Grid>
      {err && <p className="alert-warn">{err}</p>}
      {res && <p className={res.status === 'rejected' ? 'alert-warn' : 'alert-ok'}>{res.status === 'rejected' ? res.comment : 'Submitted. Hours are reserved until your manager decides.'}</p>}
      <button className="btn" onClick={send}>Submit request</button></div>
    <Table head={['Dates', 'Reason', 'Hours', 'Status', 'Note']}>{(d.requests || []).map((x: any) => <tr key={x.id}><Td>{x.startDate} to {x.endDate}</Td><Td>{x.reason}</Td><Td>{x.hours}</Td><Td><Tag s={x.status} /></Td><Td>{x.comment}</Td></tr>)}</Table></div>);
}
