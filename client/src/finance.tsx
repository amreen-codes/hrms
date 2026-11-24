import { useState } from 'react';
import { api, useLoad, user } from './api';
import { Title, Table, Tag, Td } from './pages';

const list = (d: any) => (Array.isArray(d) ? d : []);
const isHR = () => ['admin', 'hr'].includes(user().role);
const isAdmin = () => user().role === 'admin';
function useMsg() {
  const [m, set] = useState<{ ok: boolean; text: string } | null>(null);
  const banner = m && <p className={m.ok ? 'alert-ok' : 'alert-warn'} role={m.ok ? 'status' : 'alert'}>{m.text}</p>;
  const run = async (fn: () => Promise<any>, ok: string | ((r: any) => string), after?: () => void) => { try { const r = await fn(); set({ ok: true, text: typeof ok === 'function' ? ok(r) : ok }); after?.(); } catch (e: any) { set({ ok: false, text: e.message }); } };
  return { banner, run };
}
const ask = (q: string) => window.prompt(q) || '';
const money = (n: any) => Number(n || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

// ---------- P4 payroll: generate -> Finance review -> Company Admin approval -> lock -> export (unlock = new version) ----------
export function Payroll() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7)); const [rows, load] = useLoad('/payroll?period=' + period); const [emps] = useLoad('/employees'); const [hist, loadH] = useLoad('/payroll/history?period=' + period); const { banner, run } = useMsg();
  const nm = new Map(list(emps).map((e: any) => [e.id, e.name])), refresh = () => { load(); loadH(); }; const post = (path: string, extra: any = {}) => api(path, 'POST', { period, ...extra });
  const count = (s: string) => list(rows).filter((r: any) => r.status === s).length;
  const exp = async () => { try { const t = await api('/payroll/export?period=' + period, 'GET', undefined, true); if (t.startsWith('{')) throw new Error(JSON.parse(t).error); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = `payroll-${period}.csv`; a.click(); refresh(); } catch (e: any) { run(async () => { throw e; }, ''); } };
  return (<div className="space-y-5"><Title right={<input className="input !w-40" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Pay period" />}>Payroll</Title>{banner}
    <div className="card space-y-3"><div className="flex flex-wrap gap-2 text-sm">{['draft', 'reviewed', 'approved', 'locked', 'exported'].map((s) => <span key={s} className="rounded-full bg-slate-100 px-3 py-1"><b>{count(s)}</b> {s}</span>)}</div>
      <div className="flex flex-wrap gap-2">
        {isHR() && <button className="btn" onClick={() => run(() => post('/payroll/generate'), (r) => `${r.sheets} pay sheet(s) generated from approved timesheets`, refresh)}>1. Generate</button>}
        {isHR() && <button className="btn" onClick={() => run(() => post('/payroll/review'), (r) => `${r.sheets} sheet(s) reviewed`, refresh)}>2. Finance review</button>}
        {isAdmin() && <button className="btn" onClick={() => run(() => post('/payroll/approve'), (r) => `${r.sheets} sheet(s) approved`, refresh)}>3. Approve payroll</button>}
        {isAdmin() && <button className="btn-ghost" onClick={() => { const reason = ask('What must Finance fix? (at least 10 characters)'); if (reason) run(() => post('/payroll/reject', { reason }), 'Sent back to Finance', refresh); }}>Not approved: send back</button>}
        {isHR() && <button className="btn" onClick={() => run(() => post('/payroll/lock'), 'Pay sheets locked', refresh)}>4. Lock</button>}
        {isHR() && <button className="btn-ghost" onClick={exp}>5. Export CSV</button>}
        {isAdmin() && <button className="btn-ghost" onClick={() => { const reason = ask('Reason for unlocking (at least 10 characters). Creates a new version'); if (reason) run(() => post('/payroll/unlock', { reason }), (r) => `Unlocked: new version ${r.newVersion}. Review and approve again`, refresh); }}>Unlock (new version)</button>}</div>
      <p className="hint">Finance reviews and may adjust with a reason; the Company Admin approves (a different person from the reviewer); only approved sheets can be locked. Unlock is possible until the file is exported; after export, correct in the next pay period.</p></div>
    <Table head={['Employee', 'Regular', 'OT', 'Commission', 'Bonus', 'Adjust.', 'Gross', 'Deductions', 'Net', 'Ver.', 'Status', '']}>{list(rows).map((p: any) => (<tr key={p.id}><Td>{nm.get(p.employeeId) || `#${p.employeeId}`}</Td><Td>{Number(p.regularHours).toFixed(1)}</Td><Td>{Number(p.otHours).toFixed(1)}</Td><Td>{money(p.commission)}</Td><Td>{money(p.bonus)}</Td><Td>{Number(p.adjustment) ? money(p.adjustment) : '—'}</Td><Td>{money(p.gross)}</Td><Td>{money(p.deductions)}</Td><Td>{money(p.net)}</Td><Td>v{p.version}</Td><Td><Tag s={p.status === 'locked' || p.status === 'exported' || p.status === 'approved' ? 'approved' : 'pending'} />{' '}{p.status}</Td>
      <Td>{isHR() && ['draft', 'reviewed'].includes(p.status) && <button className="btn-ghost !px-2 !py-1" onClick={() => { const amount = ask('Adjustment amount in dollars (negative to reduce)'), reason = ask('Reason (at least 10 characters)'); if (amount && reason) run(() => api(`/payroll/sheets/${p.id}/adjust`, 'POST', { amount: +amount, reason }), 'Adjusted: review it again', refresh); }}>Adjust</button>}</Td></tr>))}</Table>
    {isHR() && list(hist?.versions).length + list(hist?.exports).length > 0 && <div className="card space-y-2 text-sm"><h2 className="font-semibold">History</h2>
      {list(hist?.versions).map((v: any) => <div key={'v' + v.id}>Unlocked v{v.version} of {nm.get(v.employeeId) || '#' + v.employeeId}: {v.unlockReason}</div>)}{list(hist?.exports).map((x: any) => <div key={'x' + x.id}>Exported {x.period}: {x.rows} row(s), version {x.versionMax}, file hash <span className="font-mono text-xs">{String(x.fileHash).slice(0, 16)}…</span></div>)}</div>}</div>);
}

// ---------- P3 compliance: rules -> auto tasks -> overdue escalation -> waive / resolve ----------
export function Compliance() {
  const [rows, load] = useLoad('/compliance'); const [emps] = useLoad('/employees'); const [dash, loadD] = useLoad(isHR() ? '/compliance/dashboard' : '/compliance'); const [rules, loadR] = useLoad(isHR() ? '/compliance-rules' : '/compliance'); const { banner, run } = useMsg();
  const [tab, setTab] = useState('tasks'); const nm = new Map(list(emps).map((e: any) => [e.id, e.name])), refresh = () => { load(); isHR() && (loadD(), loadR()); }; const me = user();
  const [f, setF] = useState<any>({ key: 'task_handbook', jurisdiction: 'US', effectiveDate: '', type: 'Handbook acknowledgement', trigger: 'hire', dueDays: 7, retentionYears: '' });
  return (<div className="space-y-5"><Title>Compliance</Title>{banner}
    {isHR() && <div className="flex flex-wrap gap-2">{['tasks', 'dashboard', 'rules'].map((t) => <button key={t} className={tab === t ? 'btn !px-3 !py-1.5' : 'btn-ghost !px-3 !py-1.5'} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>}
    {tab === 'tasks' && <Table head={['Task', 'Employee', 'Location', 'Due', 'Status', 'Escalation', '']}>{list(rows).map((t: any) => (<tr key={t.id}><Td>{t.type}</Td><Td>{nm.get(t.employeeId) || `#${t.employeeId}`}</Td><Td>{t.locationKey || '—'}</Td><Td>{t.dueDate}</Td><Td><Tag s={t.status} />{t.waiveReason && <div className="hint">{t.waiveReason}</div>}</Td><Td>{t.escalationLevel ? `level ${t.escalationLevel}` : '—'}</Td>
      <Td><span className="flex flex-wrap gap-2">{!['done', 'waived'].includes(t.status) && <button className="btn-ghost !px-2 !py-1" onClick={() => run(() => api(`/compliance/${t.id}/complete`, 'POST'), 'Marked done', refresh)}>Mark done</button>}
        {isHR() && ['open', 'overdue'].includes(t.status) && <button className="btn-ghost !px-2 !py-1" onClick={() => { const note = ask('Escalation note'); if (note) run(() => api(`/compliance/${t.id}/escalate`, 'POST', { note }), 'Escalated', refresh); }}>Escalate</button>}
        {isHR() && ['open', 'overdue'].includes(t.status) && t.employeeId !== me.id && <button className="btn-ghost !px-2 !py-1" onClick={() => { const reason = ask('Reason for waiving (at least 10 characters, audited)'); if (reason) run(() => api(`/compliance/${t.id}/waive`, 'POST', { reason }), 'Waived', refresh); }}>Waive</button>}</span></Td></tr>))}</Table>}
    {tab === 'dashboard' && <Table head={['Task type', 'Location', 'Open', 'Due in 7 days', 'Overdue', 'Done', 'Waived']}>{list(dash).map((d: any) => <tr key={d.type + d.location}><Td><b>{d.type}</b></Td><Td>{d.location}</Td><Td>{d.open}</Td><Td>{d.dueSoon}</Td><Td>{d.overdue > 0 ? <Tag s="rejected" /> : null} {d.overdue}</Td><Td>{d.done}</Td><Td>{d.waived}</Td></tr>)}</Table>}
    {tab === 'rules' && <div className="space-y-4"><div className="card space-y-3"><h2 className="font-semibold">Task rule (per company or location)</h2>
      <div className="grid gap-3 sm:grid-cols-4"><input className="input" placeholder="Rule key (task_...)" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /><input className="input" placeholder="US, CA or CA:Los Angeles" value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })} /><input className="input" type="date" aria-label="Effective" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /><input className="input" placeholder="Task name" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} />
        <select className="input" value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}><option value="hire">On hire</option><option value="annual">Every year</option></select><input className="input" type="number" placeholder="Due in (days)" value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: e.target.value })} /><input className="input" type="number" placeholder="Retention (years)" value={f.retentionYears} onChange={(e) => setF({ ...f, retentionYears: e.target.value })} /></div>
      <div className="flex flex-wrap gap-2"><button className="btn" onClick={() => run(() => api('/compliance-rules', 'POST', { key: f.key, jurisdiction: f.jurisdiction, effectiveDate: f.effectiveDate, verified: true, value: { type: f.type, trigger: f.trigger, dueDays: +f.dueDays, ...(f.retentionYears ? { retentionYears: +f.retentionYears } : {}) } }), 'Rule version saved', refresh)}>Save rule</button>
        <button className="btn-ghost" onClick={() => run(() => api('/compliance/generate', 'POST'), (r) => `${r.created} task(s) created`, refresh)}>Create tasks from rules now</button></div>
      <p className="hint">The most specific location wins (city, then state, then US). Tasks are created automatically every day. Training and credential tasks come from their own modules.</p></div>
      <Table head={['Rule', 'Location', 'Version', 'Effective', 'Task', 'Trigger', 'Due', 'Retention']}>{list(rules).filter((r: any) => String(r.key).startsWith('task_')).map((r: any) => <tr key={r.id}><Td>{r.key}</Td><Td>{r.jurisdiction}</Td><Td>v{r.version}</Td><Td>{r.effectiveDate}</Td><Td>{r.value?.type}</Td><Td>{r.value?.trigger}</Td><Td>{r.value?.dueDays} d</Td><Td>{r.value?.retentionYears ?? '—'}</Td></tr>)}</Table></div>}</div>);
}
