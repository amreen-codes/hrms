import { useState } from 'react';
import { api, useLoad, user } from './api';
import { Title, Table, Tag, Td } from './pages';

const isHR = () => ['admin', 'hr'].includes(user().role);
const staff = () => user().role !== 'employee';
function useMsg() {
  const [m, set] = useState<{ ok: boolean; text: string } | null>(null);
  const banner = m && <p className={m.ok ? 'alert-ok' : 'alert-warn'} role={m.ok ? 'status' : 'alert'}>{m.text}</p>;
  const run = async (fn: () => Promise<any>, ok: string | ((r: any) => string), after?: () => void) => { try { const r = await fn(); set({ ok: true, text: typeof ok === 'function' ? ok(r) : ok }); after?.(); } catch (e: any) { set({ ok: false, text: e.message }); } };
  return { banner, run };
}
const list = (d: any) => (Array.isArray(d) ? d : []);

// ---------- P19 part-time review (HR) ----------
export function PartTime() {
  const [d, load] = useLoad('/part-time/review'); const [hist, loadH] = useLoad('/part-time/reviews'); const { banner, run } = useMsg();
  const decide = (r: any, decision: 'keep' | 'reclassify') => { const note = window.prompt(decision === 'keep' ? 'Note for the record' : 'Reason for reclassifying to full-time') || ''; if (note.length < 5) return; run(() => api(`/part-time/review/${r.employeeId}`, 'POST', { decision, note }), decision === 'keep' ? 'Review recorded' : 'Reclassified to full-time: employee notified', () => { load(); loadH(); }); };
  return (<div className="space-y-5"><Title>Part-time review</Title>{banner}
    <p className="hint">Quarter {d?.quarter}. Average weekly hours come from approved timesheets over the last 12 months. At 30+ hours a week the employee counts as full-time for ACA and should be reclassified; FMLA needs 12 months and 1,250 hours; the long-term part-time 401(k) rule needs 500+ hours in two consecutive years. Thresholds are guidance: confirm them with counsel.</p>
    <Table head={['Employee', 'Avg hrs/week', 'ACA 30h', 'FMLA hours', '401(k) rule', 'This quarter', '']}>{list(d?.rows).map((r: any) => (<tr key={r.employeeId}>
      <Td><b>{r.name}</b></Td><Td>{r.avgWeekly}</Td><Td><Tag s={r.aca ? 'rejected' : 'approved'} />{r.aca && <span className="ml-1 text-xs">reclassify</span>}</Td><Td>{r.fmla ? 'eligible' : '—'}</Td><Td>{r.ltpt401k ? 'eligible' : '—'}</Td><Td>{r.reviewedThisQuarter ? 'reviewed' : 'pending'}</Td>
      <Td>{!r.reviewedThisQuarter && <span className="flex gap-2"><button className="btn-ghost !px-2 !py-1" onClick={() => decide(r, 'keep')}>Keep part-time</button>{r.reclassify && <button className="btn !px-2 !py-1" onClick={() => decide(r, 'reclassify')}>Reclassify</button>}</span>}</Td></tr>))}</Table>
    <h2 className="font-semibold">Review history</h2>
    <Table head={['Employee', 'Quarter', 'Avg hrs', 'Decision', 'Note']}>{list(hist).map((h: any) => <tr key={h.id}><Td>{h.employeeName}</Td><Td>{h.quarter}</Td><Td>{h.avgWeekly}</Td><Td><Tag s={h.decision === 'keep' ? 'approved' : 'verified'} />{' '}{h.decision}</Td><Td>{h.note}</Td></tr>)}</Table></div>);
}

// ---------- P19 schedules ----------
export function Schedules() {
  const [rows, load] = useLoad('/schedules'); const [emps] = useLoad('/employees'); const { banner, run } = useMsg();
  const [f, setF] = useState({ employeeId: '', weekStart: '', shifts: '' }); const me = user();
  const change = (p: any) => { const shifts = window.prompt('New shifts', p.shifts) || ''; if (!shifts) return; const reason = window.prompt('Reason for the change (required)') || ''; if (!reason) return; run(() => api(`/schedules/${p.id}/change`, 'POST', { shifts, reason }), 'Change recorded and employee notified', load); };
  return (<div className="space-y-5"><Title>Schedules</Title>{banner}
    {staff() && <div className="card space-y-3"><h2 className="font-semibold">Publish a weekly schedule</h2>
      <div className="grid gap-3 sm:grid-cols-3"><select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Employee…</option>{list(emps).filter((e: any) => e.id !== me.id && e.status !== 'terminated').map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        <input className="input" type="date" aria-label="Week start" value={f.weekStart} onChange={(e) => setF({ ...f, weekStart: e.target.value })} /><input className="input" placeholder="Shifts, e.g. Mon-Fri 9:00-13:00" value={f.shifts} onChange={(e) => setF({ ...f, shifts: e.target.value })} /></div>
      <button className="btn" onClick={() => run(() => api('/schedules', 'POST', { ...f, employeeId: +f.employeeId }), (r) => r.lateNotice ? `Published, but inside the ${r.noticeDays}-day advance-notice window for this location` : 'Published and employee notified', load)}>Publish</button>
      <p className="hint">Where predictive-scheduling laws apply (for example New York City, Chicago, Seattle, San Francisco, Philadelphia, Los Angeles, Oregon) the system warns when notice is short and logs every change. Verify the exact notice and premium-pay rules for each location.</p></div>}
    <Table head={['Employee', 'Week of', 'Shifts', 'Notice', 'Changes', '']}>{list(rows).map((p: any) => (<tr key={p.id}><Td>{p.employeeName}</Td><Td>{p.weekStart}</Td><Td>{p.shifts}</Td>
      <Td>{p.noticeDays ? `${p.noticeDays} days required` : 'none required'}{p.lateNotice && <span className="ml-1"><Tag s="rejected" /> late</span>}</Td><Td>{(p.changeLog || []).length}{(p.changeLog || []).some((c: any) => c.lateChange) && ' (late change)'}</Td>
      <Td>{staff() && <button className="btn-ghost !px-2 !py-1" onClick={() => change(p)}>Record change</button>}</Td></tr>))}</Table></div>);
}

// ---------- P16 paid sick leave admin (HR) ----------
export function SickAdmin() {
  const [ledger, load] = useLoad('/sick-leave/ledger'); const [f, setF] = useState({ periodStart: '', periodEnd: '' }); const [year, setYear] = useState(String(new Date().getFullYear()));
  const { banner, run } = useMsg(); const [out, setOut] = useState<any>(null);
  return (<div className="space-y-5"><Title>Paid sick leave accrual</Title>{banner}
    <div className="card space-y-3"><h2 className="font-semibold">1. Load state rules</h2>
      <button className="btn-ghost" onClick={() => run(() => api('/compliance-rules/seed-psl', 'POST'), (r) => `${r.created} jurisdictions loaded from Appendix A2 as UNVERIFIED (${r.skipped} already present)`)}>Load Appendix A2 rules</button>
      <p className="hint">These are the values printed in the BPMN document. Confirm each state with counsel in Compliance rules and add a verified version. States without a rule use company policy.</p></div>
    <div className="card space-y-3"><h2 className="font-semibold">2. Accrue for a pay period</h2>
      <div className="grid gap-3 sm:grid-cols-3"><input className="input" type="date" aria-label="Period start" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} /><input className="input" type="date" aria-label="Period end" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />
        <button className="btn" onClick={() => run(async () => setOut(await api('/sick-leave/accrue', 'POST', f)), 'Accrual run complete', load)}>Run accrual</button></div>
      {out && <div className="space-y-1 text-sm"><div>Accrued for {out.accrued.length} employee(s); already done: {out.alreadyDone}; no state rule (company policy): {out.noRule.length}.</div>{out.review.map((x: string) => <div key={x} className="alert-warn">{x}</div>)}</div>}
      <p className="hint">Hours come from approved timesheets (part-time staff accrue from their first hour). A period can only be accrued once.</p></div>
    <div className="card space-y-3"><h2 className="font-semibold">3. Year-end carryover</h2>
      <div className="flex gap-3"><input className="input max-w-[8rem]" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" /><button className="btn-ghost" onClick={() => run(async () => setOut(await api('/sick-leave/year-end', 'POST', { year: +year })), (r) => `Year-end applied to ${r.reset} balance(s)`, load)}>Apply year-end</button></div></div>
    <h2 className="font-semibold">Ledger</h2>
    <Table head={['Employee', 'Type', 'Period', 'Hours worked', 'Accrued', 'Rule', 'Note']}>{list(ledger).map((l: any) => <tr key={l.id}><Td>{l.employeeName}</Td><Td>{l.kind}</Td><Td>{l.periodStart} → {l.periodEnd}</Td><Td>{l.hoursWorked}</Td><Td>{l.accrued}</Td><Td>{l.ruleJurisdiction} v{l.ruleVersion}</Td><Td>{l.note}</Td></tr>)}</Table></div>);
}

// ---------- P15 benefit plans + enrollment windows (HR) ----------
export function BenefitsAdmin() {
  const [plans, load] = useLoad('/benefit-plans'); const [cat] = useLoad('/benefits/catalog'); const [wins, loadW] = useLoad('/enrollment-windows'); const { banner, run } = useMsg();
  const [f, setF] = useState<any>({ code: '', name: '', catalogItem: 'Medical Insurance', employerPct: 70, minHours: 30, waitingDays: 30, windowDays: 30, preTax: true, employee: 0, spouse: 0, children: 0, family: 0 }); const [w, setW] = useState({ startDate: '', endDate: '' });
  const num = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (<div className="space-y-5"><Title>Benefit plans</Title>{banner}
    <div className="card space-y-3"><h2 className="font-semibold">Create a plan from the benefits catalog</h2>
      <div className="grid gap-3 sm:grid-cols-3"><select className="input" value={f.catalogItem} onChange={(e) => setF({ ...f, catalogItem: e.target.value })}>{list(cat).map((c: any) => <option key={c.no} value={c.name}>{c.no}. {c.name}</option>)}</select>
        <input className="input" placeholder="Plan code (e.g. gold-medical)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /><input className="input" placeholder="Plan name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="grid gap-3 sm:grid-cols-4">{[['employerPct', 'Employer share %'], ['minHours', 'Min hours/week'], ['waitingDays', 'Waiting days'], ['windowDays', 'Enrollment window (days)']].map(([k, l]) => <label key={k} className="text-sm">{l}<input className="input" type="number" value={f[k]} onChange={num(k)} /></label>)}</div>
      <div className="grid gap-3 sm:grid-cols-4">{[['employee', 'Employee only $/mo'], ['spouse', 'Employee + spouse'], ['children', 'Employee + children'], ['family', 'Family']].map(([k, l]) => <label key={k} className="text-sm">{l}<input className="input" type="number" value={f[k]} onChange={num(k)} /></label>)}</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.preTax} onChange={(e) => setF({ ...f, preTax: e.target.checked })} />Pre-tax deduction</label>
      <button className="btn" onClick={() => run(() => api('/benefit-plans', 'POST', { code: f.code, name: f.name, catalogItem: f.catalogItem, employerPct: +f.employerPct, minHours: +f.minHours, waitingDays: +f.waitingDays, windowDays: +f.windowDays, preTax: f.preTax, cost: { employee: +f.employee, spouse: +f.spouse, children: +f.children, family: +f.family } }), 'Plan created', load)}>Create plan</button></div>
    <Table head={['Plan', 'Catalog item', 'Employer', 'Min hrs', 'Waiting', 'Window', 'Employee cost/mo', 'Status', '']}>{list(plans).map((p: any) => (<tr key={p.id}><Td><b>{p.name}</b><div className="text-xs text-slate-500">{p.code}</div></Td><Td>{p.catalogItem}</Td><Td>{p.employerPct}%</Td><Td>{p.minHours}</Td><Td>{p.waitingDays} d</Td><Td>{p.windowDays} d</Td><Td>${p.cost?.employee}</Td><Td><Tag s={p.active ? 'active' : 'rejected'} /></Td>
      <Td><button className="btn-ghost !px-2 !py-1" onClick={() => run(() => api(`/benefit-plans/${p.id}`, 'PATCH', { active: !p.active }), p.active ? 'Plan retired (existing enrollments stay)' : 'Plan reactivated', load)}>{p.active ? 'Retire' : 'Reactivate'}</button></Td></tr>))}</Table>
    <div className="card space-y-3"><h2 className="font-semibold">Open enrollment</h2>
      <div className="grid gap-3 sm:grid-cols-3"><input className="input" type="date" aria-label="Start" value={w.startDate} onChange={(e) => setW({ ...w, startDate: e.target.value })} /><input className="input" type="date" aria-label="End" value={w.endDate} onChange={(e) => setW({ ...w, endDate: e.target.value })} />
        <button className="btn" onClick={() => run(() => api('/enrollment-windows', 'POST', w), 'Open enrollment created', loadW)}>Open window</button></div>
      <Table head={['Type', 'Employee', 'From', 'To', 'Event', 'Status', '']}>{list(wins).map((x: any) => (<tr key={x.id}><Td className="capitalize">{x.kind.replace('_', ' ')}</Td><Td>{x.employeeName || 'Everyone'}</Td><Td>{x.startDate}</Td><Td>{x.endDate}</Td><Td>{x.event?.replace('_', '/')}</Td><Td>{x.voidedAt ? 'voided' : 'active'}</Td>
        <Td>{!x.voidedAt && <button className="btn-ghost !px-2 !py-1" onClick={() => run(() => api(`/enrollment-windows/${x.id}/void`, 'POST'), 'Window voided', loadW)}>Void</button>}</Td></tr>))}</Table></div></div>);
}

// ---------- P15 enrollment status + life events (everyone) ----------
export function Enrollment() {
  const [wins, load] = useLoad('/enrollment-windows'); const { banner, run } = useMsg(); const [f, setF] = useState({ event: 'marriage', eventDate: '' }); const today = new Date().toISOString().slice(0, 10);
  const active = list(wins).filter((w: any) => !w.voidedAt && w.startDate <= today && w.endDate >= today);
  return (<div className="space-y-5"><Title>Benefits enrollment</Title>{banner}
    <div className={active.length ? 'alert-ok' : 'alert-warn'}>{active.length ? `Enrollment is open until ${active.map((w: any) => w.endDate).sort().slice(-1)[0]}.` : 'Enrollment is closed right now. You can enroll after you become eligible, during open enrollment, or within 30 days of a qualifying life event.'}</div>
    <div className="card space-y-3"><h2 className="font-semibold">Report a qualifying life event</h2>
      <div className="grid gap-3 sm:grid-cols-3"><select className="input" value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })}><option value="marriage">Marriage</option><option value="birth_adoption">Birth or adoption</option><option value="loss_of_coverage">Loss of other coverage</option></select>
        <input className="input" type="date" aria-label="Event date" value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} /><button className="btn" onClick={() => run(() => api('/life-events', 'POST', f), 'Recorded: your enrollment window is open for 30 days from the event date', load)}>Open my enrollment window</button></div>
      <p className="hint">The event must be within 30 days of today. HR may ask for supporting documents when you add dependents.</p></div>
    <Table head={['Type', 'From', 'To', 'Event']}>{list(wins).filter((w: any) => !w.voidedAt).map((x: any) => <tr key={x.id}><Td className="capitalize">{x.kind.replace('_', ' ')}</Td><Td>{x.startDate}</Td><Td>{x.endDate}</Td><Td>{x.event?.replace('_', '/')}</Td></tr>)}</Table></div>);
}
