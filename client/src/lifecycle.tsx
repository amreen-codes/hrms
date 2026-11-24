import { useEffect, useState } from 'react';
import { Bell, ArrowLeft, ShieldCheck } from 'lucide-react';
import { api, useLoad, user } from './api';
import { Title, Table, Tag, Td } from './pages';
import { Field, Grid, Toggle } from './forms';

const today = () => new Date().toISOString().slice(0, 10);
const isHR = () => ['admin', 'hr'].includes(user().role);
const when = (d: any) => (d ? new Date(d).toLocaleString() : '');
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

/** Runs an API call and shows its error or success message. */
function useAction() {
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<any>, ok = 'Saved') => { setBusy(true); setMsg(null); try { const r = await fn(); setMsg({ ok: true, t: ok }); return r ?? true; } catch (e: any) { setMsg({ ok: false, t: e.message }); return null; } finally { setBusy(false); } };
  const box = msg && <div role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'alert-ok' : 'alert-warn !border-red-200 !bg-red-50 !text-red-700'}>{msg.t}</div>;
  return { run, busy, box, setMsg };
}
const Modal = ({ title, onClose, children }: any) => (
  <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 grid place-items-center bg-navy-950/60 p-3 backdrop-blur-sm">
    <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h2 className="font-serif text-xl">{title}</h2><button className="btn-ghost" onClick={onClose}>Close</button></div>{children}</div>
  </div>
);
const Loading = ({ d }: any) => (d === null ? <p className="text-sm text-slate-500">Loading...</p> : null);

// ---------------------------------------------------------------- notification bell
export function NotificationBell() {
  const [d, setD] = useState<any>({ unread: 0, notifications: [] }); const [open, setOpen] = useState(false);
  const load = () => api('/notifications').then(setD).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  return (
    <div className="relative">
      <button className="relative rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label={`Notifications, ${d.unread} unread`} aria-expanded={open} onClick={() => { setOpen(!open); load(); }}>
        <Bell size={20} />{d.unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">{d.unread > 9 ? '9+' : d.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(22rem,90vw)] rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5"><b className="text-sm">Notifications</b>
            <button className="text-xs font-semibold text-brand disabled:opacity-40" disabled={!d.unread} onClick={async () => { await api('/notifications/read-all', 'POST'); load(); }}>Mark all read</button></div>
          <ul className="max-h-96 divide-y overflow-y-auto">
            {d.notifications.length === 0 && <li className="p-4 text-sm text-slate-500">You are all caught up.</li>}
            {d.notifications.map((n: any) => (
              <li key={n.id}><button className={`block w-full px-4 py-3 text-left text-sm hover:bg-slate-50 ${n.readAt ? 'text-slate-500' : ''}`} onClick={async () => { if (!n.readAt) { await api(`/notifications/${n.id}/read`, 'POST'); load(); } }}>
                <div className={n.readAt ? '' : 'font-semibold'}>{n.title}</div>{n.body && <div className="text-xs text-slate-500">{n.body}</div>}<div className="mt-0.5 text-[11px] text-slate-400">{when(n.createdAt)}</div></button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shared checklist table
function Checklist({ tasks, canAct, reload, needNote = [] }: { tasks: any[]; canAct: (t: any) => boolean; reload: () => void; needNote?: string[] }) {
  const a = useAction(); const [notes, setNotes] = useState<any>({}); const t0 = today();
  return (
    <div className="space-y-2">{a.box}
      <Table head={['Task', 'Owner', 'Due', 'Status', '']}>
        {tasks.map((t) => (
          <tr key={t.id}>
            <Td>{t.title}{!t.mandatory && <span className="ml-1 text-xs text-slate-400">(optional)</span>}</Td>
            <Td className="capitalize">{t.team || t.ownerRole}</Td>
            <Td>{t.dueDate}</Td>
            <Td><Tag s={t.status === 'open' && t.dueDate < t0 ? 'overdue' : t.status} /></Td>
            <Td>
              {t.status === 'open' && (t.auto ? <span className="text-xs text-slate-400">Completes automatically</span> : canAct(t) && (
                <div className="flex flex-wrap gap-2">
                  {needNote.includes(t.key) && <input className="input !w-44 !py-1.5" placeholder="Note (required)" aria-label={`Note for ${t.title}`} value={notes[t.id] || ''} onChange={(e) => setNotes({ ...notes, [t.id]: e.target.value })} />}
                  <button className="btn-ghost !py-1.5" disabled={a.busy} onClick={async () => { if (await a.run(() => api(`/lifecycle/tasks/${t.id}/complete`, 'POST', { note: notes[t.id] || '' }), 'Task completed')) reload(); }}>Mark done</button>
                </div>))}
              {t.status === 'done' && <span className="text-xs text-slate-400">{when(t.completedAt)}</span>}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------- P5 forms
function FormShell({ title, hint, children, onSubmit, busy, box, submit = 'Submit' }: any) {
  return (
    <form className="card space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div><h3 className="font-semibold">{title}</h3>{hint && <p className="hint">{hint}</p>}</div>{children}{box}
      <button className="btn" disabled={busy}>{busy ? 'Saving...' : submit}</button>
    </form>
  );
}
const useF = (init: any) => { const [f, setF] = useState<any>(init); const on = (k: string) => (e: any) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }); return { f, setF, on, inp: (k: string, p: any = {}) => <input className="input" value={f[k] ?? ''} onChange={on(k)} {...p} /> }; };
const stateSel = (f: any, on: any) => <select className="input" value={f.state} onChange={on('state')}>{STATES.map((s) => <option key={s}>{s}</option>)}</select>;

function I9Section1({ emp, done }: any) {
  const a = useAction(); const { f, on, inp } = useF({ firstName: emp.name.split(' ')[0], lastName: emp.name.split(' ').slice(1).join(' '), state: 'TX', citizenshipStatus: 'citizen', attestation: false });
  const alien = f.citizenshipStatus === 'authorized_alien', lpr = f.citizenshipStatus === 'lawful_permanent_resident';
  return (
    <FormShell title="Form I-9, Section 1" hint="Your answers are encrypted. Choose your own status. You are never asked for specific documents here." busy={a.busy} box={a.box}
      onSubmit={async () => { if (await a.run(() => api(`/onboarding/${emp.id}/i9-section1`, 'POST', f), 'Section 1 submitted')) done(); }}>
      <Grid><Field label="First name">{inp('firstName')}</Field><Field label="Last name">{inp('lastName')}</Field><Field label="Middle initial">{inp('middleInitial', { maxLength: 1 })}</Field><Field label="Other last names used">{inp('otherLastNames')}</Field>
        <Field label="Street address" span={2}>{inp('street')}</Field><Field label="City">{inp('city')}</Field><Field label="State">{stateSel(f, on)}</Field><Field label="ZIP">{inp('zip', { inputMode: 'numeric' })}</Field>
        <Field label="Date of birth">{inp('dob', { type: 'date', max: today() })}</Field><Field label="SSN (optional)" hint="Encrypted. Only required if your employer uses E-Verify.">{inp('ssn', { inputMode: 'numeric', autoComplete: 'off', maxLength: 11 })}</Field>
        <Field label="Email">{inp('email', { type: 'email' })}</Field><Field label="Phone">{inp('phone', { type: 'tel' })}</Field>
        <Field label="I attest that I am" span={2}><select className="input" value={f.citizenshipStatus} onChange={on('citizenshipStatus')}><option value="citizen">A citizen of the United States</option><option value="noncitizen_national">A noncitizen national of the United States</option><option value="lawful_permanent_resident">A lawful permanent resident</option><option value="authorized_alien">A noncitizen authorized to work</option></select></Field>
        {(lpr || alien) && <Field label="USCIS A-Number">{inp('alienNumber')}</Field>}
        {alien && <><Field label="Work authorization expires">{inp('workAuthExpiry', { type: 'date' })}</Field><Field label="I-94 number">{inp('i94Number')}</Field><Field label="Foreign passport number">{inp('passportNumber')}</Field><Field label="Country of issuance">{inp('passportCountry')}</Field></>}
      </Grid>
      <Toggle on={f.attestation} set={on('attestation')} label="I attest, under penalty of perjury, that this information is true and correct." />
      <Field label="Type your full name to sign">{inp('signedName')}</Field>
    </FormShell>
  );
}
function W4Form({ emp, done }: any) {
  const a = useAction(); const { f, on, inp } = useF({ firstName: emp.name.split(' ')[0], lastName: emp.name.split(' ').slice(1).join(' '), state: 'TX', filingStatus: 'single', multipleJobs: false, claimExempt: false, attestation: false });
  return (
    <FormShell title="Form W-4, Employee's Withholding Certificate" hint="Your SSN and tax details are encrypted." busy={a.busy} box={a.box} onSubmit={async () => { if (await a.run(() => api(`/onboarding/${emp.id}/w4`, 'POST', f), 'W-4 submitted')) done(); }}>
      <Grid><Field label="First name">{inp('firstName')}</Field><Field label="Last name">{inp('lastName')}</Field><Field label="Social Security number">{inp('ssn', { inputMode: 'numeric', autoComplete: 'off', maxLength: 11 })}</Field>
        <Field label="Filing status"><select className="input" value={f.filingStatus} onChange={on('filingStatus')}><option value="single">Single or married filing separately</option><option value="married">Married filing jointly</option><option value="head">Head of household</option></select></Field>
        <Field label="Street address" span={2}>{inp('street')}</Field><Field label="City">{inp('city')}</Field><Field label="State">{stateSel(f, on)}</Field><Field label="ZIP">{inp('zip', { inputMode: 'numeric' })}</Field>
        <Field label="Dependents credit (USD)">{inp('dependentsCredit', { type: 'number', min: 0 })}</Field><Field label="Other income (USD)">{inp('otherIncome', { type: 'number', min: 0 })}</Field><Field label="Deductions (USD)">{inp('deductions', { type: 'number', min: 0 })}</Field><Field label="Extra withholding per period (USD)">{inp('extraWithholding', { type: 'number', min: 0 })}</Field></Grid>
      <div className="flex flex-wrap gap-x-8 gap-y-3"><Toggle on={f.multipleJobs} set={on('multipleJobs')} label="I have multiple jobs or my spouse works" /><Toggle on={f.claimExempt} set={on('claimExempt')} label="I claim exemption from withholding" /></div>
      <Toggle on={f.attestation} set={on('attestation')} label="Under penalties of perjury, this certificate is true, correct and complete." /><Field label="Type your full name to sign">{inp('signedName')}</Field>
    </FormShell>
  );
}
function HandbookForm({ emp, version, done }: any) {
  const a = useAction(); const { f, on, inp } = useF({ accept: false });
  return (
    <FormShell title={`Employee handbook and policies (version ${version})`} hint="Your name, the time, your IP address and the version are recorded as your signature." busy={a.busy} box={a.box} submit="Sign" onSubmit={async () => { if (await a.run(() => api(`/onboarding/${emp.id}/handbook`, 'POST', f), 'Signed')) done(); }}>
      <Toggle on={f.accept} set={on('accept')} label="I have read and accept the handbook and policies." /><Field label="Type your full name exactly as shown on your profile">{inp('signedName', { placeholder: emp.name })}</Field>
    </FormShell>
  );
}
function EmergencyForm({ emp, current, done }: any) {
  const a = useAction(); const { f, inp } = useF({ name: current?.name || '', relationship: current?.relationship || '', phone: current?.phone || '' });
  return (
    <FormShell title="Emergency contact" busy={a.busy} box={a.box} onSubmit={async () => { if (await a.run(() => api(`/onboarding/${emp.id}/emergency-contact`, 'PUT', f), 'Emergency contact saved')) done(); }}>
      <Grid><Field label="Full name">{inp('name')}</Field><Field label="Relationship">{inp('relationship')}</Field><Field label="Phone">{inp('phone', { type: 'tel' })}</Field></Grid>
    </FormShell>
  );
}
function I9Section2({ emp, done }: any) {
  const a = useAction(); const { f, setF, on, inp } = useF({ documentChoice: 'list_a', firstDayOfEmployment: emp.startDate || today(), examinedOn: today(), employerRepName: user().name, attestation: false });
  const blank = (listType: string) => ({ listType, title: '', issuingAuthority: '', documentNumber: '', expiry: '' });
  const [docs, setDocs] = useState<any[]>([blank('A')]);
  const choose = (v: string) => { setF({ ...f, documentChoice: v }); setDocs(v === 'list_a' ? [blank('A')] : [blank('B'), blank('C')]); };
  const upd = (i: number, k: string, v: string) => setDocs(docs.map((d, j) => (j === i ? { ...d, [k]: v } : d)));
  return (
    <FormShell title="Form I-9, Section 2 (employer review)" hint="Record the documents the employee chose to present. Do not specify which documents they must show. Due within 3 business days of the first day of employment." busy={a.busy} box={a.box}
      onSubmit={async () => { if (await a.run(() => api(`/onboarding/${emp.id}/i9-section2`, 'POST', { ...f, documents: docs.map((d) => ({ ...d, expiry: d.expiry || undefined })) }), 'Section 2 submitted')) done(); }}>
      <Grid><Field label="Documents presented"><select className="input" value={f.documentChoice} onChange={(e) => choose(e.target.value)}><option value="list_a">One List A document</option><option value="list_b_and_c">One List B and one List C document</option></select></Field>
        <Field label="First day of employment">{inp('firstDayOfEmployment', { type: 'date' })}</Field><Field label="Date examined">{inp('examinedOn', { type: 'date', max: today() })}</Field><Field label="Employer representative">{inp('employerRepName')}</Field></Grid>
      {docs.map((d, i) => (
        <div key={i} className="grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-2"><div className="sm:col-span-2 text-xs font-semibold uppercase text-slate-500">List {d.listType} document</div>
          {[['title', 'Document title'], ['issuingAuthority', 'Issuing authority'], ['documentNumber', 'Document number']].map(([k, l]) => <Field key={k} label={l}><input className="input" value={d[k]} onChange={(e) => upd(i, k, e.target.value)} /></Field>)}
          <Field label="Expiry (if any)"><input className="input" type="date" value={d.expiry} onChange={(e) => upd(i, 'expiry', e.target.value)} /></Field></div>
      ))}
      <Toggle on={f.attestation} set={on('attestation')} label="I attest that I examined the document(s) and they appear genuine and relate to the employee." />
    </FormShell>
  );
}
function AssignPanel({ emp, done }: any) {
  const a = useAction(); const [people] = useLoad('/employees'); const [mid, setMid] = useState(''); const [items, setItems] = useState<any[]>([{ item: '', assetTag: '' }]);
  const mgrs = (people || []).filter((p: any) => ['manager', 'hr', 'admin'].includes(p.role) && p.id !== emp.id && p.status !== 'terminated');
  return (
    <FormShell title="Assign manager and equipment" busy={a.busy} box={a.box} onSubmit={async () => { if (await a.run(() => api(`/onboarding/${emp.id}/assign`, 'POST', { managerId: Number(mid), equipment: items.filter((i) => i.item.trim()) }), 'Assigned')) done(); }}>
      <Field label="Manager"><select className="input" value={mid} onChange={(e) => setMid(e.target.value)}><option value="">Choose a manager</option>{mgrs.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      {items.map((it, i) => (<div key={i} className="grid gap-2 sm:grid-cols-2"><input className="input" aria-label="Equipment item" placeholder="Item (e.g. Laptop)" value={it.item} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))} />
        <input className="input" aria-label="Asset tag" placeholder="Asset tag" value={it.assetTag} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, assetTag: e.target.value } : x)))} /></div>))}
      <button type="button" className="btn-ghost" onClick={() => setItems([...items, { item: '', assetTag: '' }])}>Add another item</button>
    </FormShell>
  );
}
function SensitiveViewer({ emp }: any) {
  const a = useAction(); const [view, setView] = useState<any>(null);
  return (
    <div className="card space-y-3"><div className="flex items-center gap-2"><ShieldCheck size={18} className="text-brand" /><h3 className="font-semibold">Encrypted records</h3></div>
      <p className="hint">Viewing decrypted I-9 and W-4 data is restricted to HR and every view is written to the audit log.</p>{a.box}
      <div className="flex flex-wrap gap-2">{[['i9_s1', 'I-9 Section 1'], ['i9_s2', 'I-9 Section 2'], ['w4', 'W-4']].map(([k, l]) => (
        <button key={k} className="btn-ghost" disabled={a.busy} onClick={async () => { const r = await a.run(() => api(`/onboarding/${emp.id}/sensitive/${k}`), `${l} opened`); if (r && r !== true) setView({ title: l, ...r }); }}>{l}</button>))}</div>
      {view && <Modal title={`${view.title} (${emp.name})`} onClose={() => setView(null)}><dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">{Object.entries(view.data).map(([k, v]: any) => <div key={k}><dt className="text-xs uppercase text-slate-500">{k}</dt><dd className="break-words">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}</dl></Modal>}
    </div>
  );
}

// ---------------------------------------------------------------- P5 onboarding pages
function OnboardingDetail({ id, onBack }: { id: number; onBack?: () => void }) {
  const [d, load] = useLoad(`/onboarding/${id}`); const a = useAction();
  if (d === null) return <Loading d={d} />;
  if (!d.employee) return <div className="alert-warn">Onboarding information is not available.</div>;
  const e = d.employee, self = d.viewer === 'self', hrv = d.viewer === 'hr'; const open = (k: string) => d.tasks.find((t: any) => t.key === k)?.status === 'open';
  return (
    <div className="space-y-4">
      {onBack && <button className="btn-ghost" onClick={onBack}><ArrowLeft size={16} />All onboarding</button>}
      <Title right={hrv && <button className="btn-ghost" disabled={a.busy} onClick={async () => { await a.run(() => api(`/onboarding/${id}/chase`, 'POST'), 'Reminders sent to the people with pending items'); load(); }}>Chase pending items</button>}>{self ? 'My onboarding' : `Onboarding: ${e.name}`}</Title>
      {a.box}
      <div className="card flex flex-wrap items-center gap-x-8 gap-y-2 text-sm"><span>Status: <Tag s={e.status} /></span><span>Start date: <b>{e.startDate || 'not set'}</b></span><span>Manager: <b>{d.manager?.name || 'not assigned yet'}</b></span></div>
      {d.tasks.length === 0 ? <div className="alert-ok">There is no onboarding checklist for this employee.</div> :
        <Checklist tasks={d.tasks} reload={load} canAct={(t) => (hrv && t.ownerRole !== 'employee') || (d.viewer === 'manager' && t.ownerRole === 'manager')} />}
      {self && <div className="grid gap-4 lg:grid-cols-2">
        {open('i9_s1') && <I9Section1 emp={e} done={load} />}{open('w4') && <W4Form emp={e} done={load} />}{open('handbook') && <HandbookForm emp={e} version={d.handbookVersion} done={load} />}
        {(open('emergency') || d.emergencyContact) && <EmergencyForm emp={e} current={d.emergencyContact} done={load} />}</div>}
      {hrv && <div className="grid gap-4 lg:grid-cols-2">
        {open('i9_s2') && (d.forms.i9_s1 ? <I9Section2 emp={e} done={load} /> : <div className="alert-warn">I-9 Section 2 can start once the employee completes Section 1.</div>)}
        {open('assign') && <AssignPanel emp={e} done={load} />}<SensitiveViewer emp={e} />
        <div className="card text-sm"><h3 className="mb-2 font-semibold">Equipment</h3>{d.assets.length === 0 ? <p className="text-slate-500">No equipment assigned yet.</p> : <ul className="space-y-1">{d.assets.map((x: any) => <li key={x.id}>{x.item} {x.assetTag && <span className="text-slate-500">({x.assetTag})</span>} <Tag s={x.status} /></li>)}</ul>}</div></div>}
    </div>
  );
}
export function Onboarding() {
  const me = user(); const [rows] = useLoad('/onboarding'); const [sel, setSel] = useState<number | null>(me.role === 'employee' ? me.id : null);
  if (sel) return <OnboardingDetail id={sel} onBack={me.role === 'employee' ? undefined : () => setSel(null)} />;
  return (
    <div><Title>Onboarding</Title><Loading d={rows} />
      {rows && (rows.length === 0 ? <div className="alert-ok">Nobody is being onboarded right now.</div> :
        <Table head={['Employee', 'Start date', 'Status', 'Progress', 'Required open', 'Overdue', '']}>
          {rows.map((r: any) => (
            <tr key={r.id}><Td><b>{r.name}</b><div className="text-xs text-slate-500">{r.title}</div></Td><Td>{r.startDate}</Td><Td><Tag s={r.status} /></Td>
              <Td><div className="h-2 w-28 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={r.done} aria-valuemin={0} aria-valuemax={r.total}><div className="h-full bg-brand" style={{ width: `${(100 * r.done) / Math.max(1, r.total)}%` }} /></div><span className="text-xs text-slate-500">{r.done} of {r.total}</span></Td>
              <Td>{r.mandatoryOpen}</Td><Td>{r.overdue ? <Tag s="overdue" /> : '0'}</Td><Td><button className="btn-ghost !py-1.5" onClick={() => setSel(r.id)}>Open</button></Td></tr>))}
        </Table>)}
    </div>
  );
}

// ---------------------------------------------------------------- P7 credentials
export function Credentials() {
  const me = user(); const [rows, load] = useLoad('/credentials'); const [sum, loadSum] = useLoad('/credentials/summary'); const [people] = useLoad(isHR() ? '/employees' : '/credentials/summary');
  const a = useAction(); const [show, setShow] = useState(false); const [renew, setRenew] = useState<any>(null); const [reject, setReject] = useState<any>(null);
  const reload = () => { load(); loadSum(); };
  const cardDefs: [string, string][] = [['compliant', 'Compliant'], ['expiring_soon', 'Expiring soon'], ['expired', 'Expired'], ['pending', 'Waiting for verification'], ['rejected', 'Rejected']];
  return (
    <div className="space-y-4">
      <Title right={<div className="flex gap-2">{isHR() && <button className="btn-ghost" disabled={a.busy} onClick={async () => { const r = await a.run(() => api('/credentials/run-reminders', 'POST'), 'Reminders checked'); if (r && r !== true) a.setMsg({ ok: true, t: `Checked ${r.checked} credential(s): ${r.reminders.length} reminder(s) sent, ${r.expired.length} newly expired.` }); reload(); }}>Run reminders now</button>}<button className="btn" onClick={() => setShow(true)}>Add credential</button></div>}>Credentials</Title>
      {a.box}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{cardDefs.map(([k, l]) => <div key={k} className="card !p-4"><div className="text-xs text-slate-500">{l}</div><div className="text-2xl font-semibold">{sum?.[k] ?? 0}</div></div>)}</div>
      {sum?.flaggedEmployees?.length > 0 && <div className="alert-warn">Employees with an expired credential: <b>{sum.flaggedEmployees.map((x: any) => x.name).join(', ')}</b></div>}
      <p className="hint">Reminders go to the employee, their manager and HR at 90, 60, 30 and 7 days before expiry. On the expiry date the credential becomes Expired and a compliance task is created.</p>
      <Loading d={rows} />
      {rows && (rows.length === 0 ? <div className="alert-ok">No credentials yet.</div> :
        <Table head={['Employee', 'Credential', 'Expires', 'Days left', 'Status', '']}>
          {rows.map((c: any) => (
            <tr key={c.id}><Td>{c.employeeName}</Td><Td><b>{c.name}</b><div className="text-xs text-slate-500">{c.type}{c.issuer ? ` · ${c.issuer}` : ''}{c.rejectionReason ? ` · Rejected: ${c.rejectionReason}` : ''}</div></Td><Td>{c.expiryDate}</Td>
              <Td className={c.daysLeft !== null && c.daysLeft <= 30 ? 'font-semibold text-red-600' : ''}>{c.daysLeft}</Td>
              <Td><Tag s={c.status} />{c.bucket === 'expiring_soon' && <span className="badge ml-1 bg-amber-100 text-amber-700">expiring soon</span>}</Td>
              <Td><div className="flex flex-wrap gap-2">
                {c.status === 'pending' && isHR() && c.employeeId !== me.id && <><button className="btn-ghost !py-1.5" disabled={a.busy} onClick={async () => { await a.run(() => api(`/credentials/${c.id}/verify`, 'POST', { approve: true }), 'Credential verified'); reload(); }}>Verify</button><button className="btn-ghost !py-1.5" onClick={() => setReject(c)}>Reject</button></>}
                {['verified', 'expired'].includes(c.status) && (c.employeeId === me.id || isHR()) && <button className="btn-ghost !py-1.5" onClick={() => setRenew(c)}>Upload renewal</button>}</div></Td></tr>))}
        </Table>)}
      {show && <CredentialForm people={isHR() ? people : null} onClose={() => setShow(false)} onSaved={reload} />}
      {renew && <CredentialForm renew={renew} onClose={() => setRenew(null)} onSaved={reload} />}
      {reject && <RejectForm c={reject} onClose={() => setReject(null)} onSaved={reload} />}
    </div>
  );
}
function CredentialForm({ people, renew, onClose, onSaved }: any) {
  const a = useAction(); const { f, on, inp } = useF({ type: renew?.type || 'License', name: renew?.name || '', issuer: renew?.issuer || '', issuedDate: '', expiryDate: '', documentRef: '', employeeId: '' });
  return (
    <Modal title={renew ? `Upload renewal: ${renew.name}` : 'Add credential'} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const body = renew ? { issuedDate: f.issuedDate || undefined, expiryDate: f.expiryDate, documentRef: f.documentRef } : { ...f, employeeId: f.employeeId ? Number(f.employeeId) : undefined, issuedDate: f.issuedDate || undefined };
        if (await a.run(() => api(renew ? `/credentials/${renew.id}/renew` : '/credentials', 'POST', body), 'Uploaded. HR will verify it.')) { onSaved(); setTimeout(onClose, 900); } }}>
        <Grid>
          {!renew && people && <Field label="Employee" hint="Leave empty for yourself."><select className="input" value={f.employeeId} onChange={on('employeeId')}><option value="">Myself</option>{people.map?.((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
          {!renew && <><Field label="Type"><select className="input" value={f.type} onChange={on('type')}>{['License', 'Certification', 'Work authorization', 'Training', 'Insurance', 'Other'].map((t) => <option key={t}>{t}</option>)}</select></Field><Field label="Name">{inp('name')}</Field><Field label="Issuer">{inp('issuer')}</Field></>}
          <Field label="Issue date">{inp('issuedDate', { type: 'date' })}</Field><Field label="Expiry date">{inp('expiryDate', { type: 'date' })}</Field>
          <Field label="Document (file name or link)" span={2} hint="File uploads are not enabled yet: store the document in your document system and reference it here.">{inp('documentRef')}</Field>
        </Grid>{a.box}<button className="btn" disabled={a.busy}>{a.busy ? 'Saving...' : 'Upload'}</button>
      </form>
    </Modal>
  );
}
function RejectForm({ c, onClose, onSaved }: any) {
  const a = useAction(); const [reason, setReason] = useState('');
  return (
    <Modal title={`Reject: ${c.name}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => api(`/credentials/${c.id}/verify`, 'POST', { approve: false, reason }), 'Rejected. The employee was notified.')) { onSaved(); setTimeout(onClose, 900); } }}>
        <Field label="Reason (sent to the employee)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>{a.box}<button className="btn" disabled={a.busy}>Reject credential</button></form>
    </Modal>
  );
}

// ---------------------------------------------------------------- P8 offboarding
const REASONS = [['resignation', 'Resignation'], ['layoff', 'Layoff / lack of work'], ['position_eliminated', 'Position eliminated'], ['end_of_contract', 'End of contract'], ['performance', 'Performance'], ['misconduct', 'Misconduct'], ['retirement', 'Retirement'], ['other', 'Other']];
function StartOffboarding({ onClose, onSaved }: any) {
  const a = useAction(); const [people] = useLoad('/employees'); const { f, on, inp } = useF({ employeeId: '', terminationDate: today(), reason: 'resignation', notes: '' });
  return (
    <Modal title="Start offboarding" onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => api('/offboarding', 'POST', { ...f, employeeId: Number(f.employeeId) }), 'Offboarding started')) { onSaved(); setTimeout(onClose, 700); } }}>
        <Grid><Field label="Employee" span={2}><select className="input" value={f.employeeId} onChange={on('employeeId')}><option value="">Choose an employee</option>{(people || []).filter((p: any) => p.status !== 'terminated' && p.id !== user().id).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Termination date" hint="Access is revoked automatically on this date.">{inp('terminationDate', { type: 'date' })}</Field>
          <Field label="Reason (restricted to HR)"><select className="input" value={f.reason} onChange={on('reason')}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Notes (restricted to HR)" span={2}><textarea className="input" rows={3} maxLength={2000} value={f.notes} onChange={on('notes')} /></Field></Grid>
        <p className="hint">Record the true reason. The state unemployment agency decides eligibility from the facts, not from the label.</p>{a.box}<button className="btn" disabled={a.busy}>Start offboarding</button>
      </form>
    </Modal>
  );
}
function OffboardingDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const [d, load] = useLoad(`/offboarding/${id}`); const a = useAction(); const [ret, setRet] = useState('');
  if (d === null) return <Loading d={d} />; if (!d.employee) return <div className="alert-warn">Not available.</div>;
  const inProgress = d.status === 'in_progress';
  return (
    <div className="space-y-4">
      <button className="btn-ghost" onClick={onBack}><ArrowLeft size={16} />All offboarding</button>
      <Title right={isHR() && inProgress && !d.accessRevokedAt && <button className="btn-ghost" disabled={a.busy} onClick={async () => { if (window.confirm('Cancel this offboarding? Open tasks will be cancelled.')) { await a.run(() => api(`/offboarding/${id}/cancel`, 'POST'), 'Offboarding cancelled'); load(); } }}>Cancel offboarding</button>}>Offboarding: {d.employee.name}</Title>
      {a.box}
      <div className="card flex flex-wrap items-center gap-x-8 gap-y-2 text-sm"><span>Status: <Tag s={d.status} /></span><span>Termination date: <b>{d.terminationDate}</b></span><span>Access: <b>{d.accessRevokedAt ? `revoked ${when(d.accessRevokedAt)}` : 'active until the termination date'}</b></span>
        {isHR() && <span>Reason: <b className="capitalize">{String(d.reason || '').replace(/_/g, ' ')}</b></span>}{d.retentionUntil && <span>Retain records until: <b>{d.retentionUntil}</b></span>}</div>
      {isHR() && d.notes && <div className="card text-sm"><b>Notes (restricted):</b> {d.notes}</div>}
      <Checklist tasks={d.tasks} reload={load} needNote={['final_pay', 'benefits_notice']} canAct={(t) => inProgress && ((isHR() && t.ownerRole !== 'employee') || (user().role === 'manager' && t.ownerRole === 'manager'))} />
      {isHR() && inProgress && <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3"><h3 className="font-semibold">Record retention</h3><p className="hint">Earliest allowed: {d.suggestedRetention} (later of the I-9 and payroll record rules). Confirm with counsel.</p>
          <div className="flex gap-2"><input className="input" type="date" aria-label="Retain until" value={ret || d.retentionUntil || d.suggestedRetention} onChange={(e) => setRet(e.target.value)} /><button className="btn" disabled={a.busy} onClick={async () => { await a.run(() => api(`/offboarding/${id}/retention`, 'POST', { retentionUntil: ret || d.retentionUntil || d.suggestedRetention }), 'Retention date saved'); load(); }}>Save</button></div></div>
        <AssetsPanel employeeId={d.employee.id} assets={d.assets} reload={load} /></div>}
      {!isHR() && d.assets.length > 0 && <div className="card text-sm"><h3 className="mb-2 font-semibold">Assets</h3><ul className="space-y-1">{d.assets.map((x: any) => <li key={x.id}>{x.item} {x.assetTag && `(${x.assetTag})`} <Tag s={x.status} /></li>)}</ul></div>}
    </div>
  );
}
function AssetsPanel({ employeeId, assets, reload }: any) {
  const a = useAction(); const { f, inp, setF } = useF({ item: '', assetTag: '' }); const [note, setNote] = useState('');
  return (
    <div className="card space-y-3"><h3 className="font-semibold">Assets and return checklist</h3>{a.box}
      {assets.length === 0 ? <p className="text-sm text-slate-500">No assets on record.</p> : <ul className="space-y-2 text-sm">{assets.map((x: any) => (
        <li key={x.id} className="flex flex-wrap items-center gap-2"><span>{x.item} {x.assetTag && <span className="text-slate-500">({x.assetTag})</span>}</span><Tag s={x.status} />
          {x.status === 'assigned' && <><button className="btn-ghost !py-1" disabled={a.busy} onClick={async () => { await a.run(() => api(`/assets/${x.id}/return`, 'POST', { status: 'returned' }), 'Marked returned'); reload(); }}>Returned</button>
            <input className="input !w-40 !py-1" placeholder="Note if missing" aria-label="Missing note" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn-ghost !py-1" disabled={a.busy} onClick={async () => { await a.run(() => api(`/assets/${x.id}/return`, 'POST', { status: 'missing', note }), 'Marked missing'); reload(); }}>Missing</button></>}</li>))}</ul>}
      <div className="flex flex-wrap gap-2"><input className="input !w-44" placeholder="Item" aria-label="New asset item" value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} /><input className="input !w-32" placeholder="Tag" aria-label="New asset tag" value={f.assetTag} onChange={(e) => setF({ ...f, assetTag: e.target.value })} />
        <button className="btn-ghost" disabled={a.busy || !f.item.trim()} onClick={async () => { if (await a.run(() => api('/assets', 'POST', { employeeId, ...f }), 'Asset added')) { setF({ item: '', assetTag: '' }); reload(); } }}>Add asset</button></div>
    </div>
  );
}
const SEP_REASONS = ['resignation', 'layoff', 'position_eliminated', 'end_of_contract', 'performance', 'misconduct', 'retirement', 'other'];
const usd = (c: number) => (c / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
function Propose({ onSaved }: { onSaved: () => void }) {
  const me = user(), mgr = me.role === 'manager'; const [emps] = useLoad('/employees');
  const [f, setF] = useState<any>({ employeeId: '', reason: 'layoff', terminationDate: '', notes: '' }); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => { try { await api('/offboarding/propose', 'POST', mgr ? { ...f, employeeId: +f.employeeId } : { terminationDate: f.terminationDate, notes: f.notes }); setMsg({ ok: true, text: 'Sent to HR for approval' }); onSaved(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } };
  return (<div className="card mb-5 space-y-3"><h2 className="font-semibold">{mgr ? 'Propose a separation for a team member' : 'Submit my resignation'}</h2>
    {msg && <p className={msg.ok ? 'alert-ok' : 'alert-warn'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    <div className="grid gap-3 sm:grid-cols-3">
      {mgr && <select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Team member…</option>{(Array.isArray(emps) ? emps : []).filter((e: any) => e.id !== me.id && e.status !== 'terminated').map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}
      {mgr && <select className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{SEP_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}</select>}
      <input className="input" type="date" aria-label="Last day" value={f.terminationDate} onChange={(e) => setF({ ...f, terminationDate: e.target.value })} /></div>
    <textarea className="input" rows={2} placeholder={mgr ? 'Facts and supporting records (restricted to HR)' : 'Anything you want HR to know (optional)'} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
    <button className="btn" onClick={send}>Send for approval</button>
    <p className="hint">Nothing starts until HR approves. The reason code is recorded accurately; a termination is never relabelled as a resignation.</p></div>);
}
function FinalPayPanel({ id }: { id: number }) {
  const [d, load] = useLoad(`/offboarding/${id}/final-pay`); const [note, setNote] = useState(''); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!d || d.error) return null;
  const confirm = async () => { try { await api(`/offboarding/${id}/final-pay/confirm`, 'POST', { note }); setMsg({ ok: true, text: 'Final pay confirmed: checklist task completed' }); load(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } };
  return (<div className="card mt-5 space-y-3"><h2 className="font-semibold">Final pay review</h2>
    {msg && <p className={msg.ok ? 'alert-ok' : 'alert-warn'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    <div className="grid gap-2 text-sm sm:grid-cols-2">
      <div>Unpaid approved timesheets: <b>{usd(d.wagesCents)}</b> <span className="hint">({d.unpaidTimesheets} timesheet(s))</span></div>
      <div>Accrued leave payout: <b>{usd(d.leavePayoutCents)}</b> <span className="hint">({d.leave.annualHoursUnused} h annual, {d.leave.sickHoursUnused} h sick unused)</span></div>
      <div>Approved bonuses not yet paid: <b>{usd(d.pendingBonusCents)}</b></div><div>Approved commission not yet paid: <b>{usd(d.pendingCommissionCents)}</b></div>
      <div className="sm:col-span-2">Wages + leave subtotal: <b>{usd(d.subtotalCents)}</b>{d.deadline && <> · Deadline rule: {d.deadline}</>}</div>
      <div className="sm:col-span-2 hint">{d.rule ? `State rule used: ${d.rule.jurisdiction} v${d.rule.version} (${d.rule.verified ? 'verified' : 'not verified'})` : `No rule configured for ${d.employee.state || 'this state'}.`}</div></div>
    {d.needsReview.length > 0 && <div className="alert-warn"><b>HR review needed</b><ul className="ml-4 list-disc">{d.needsReview.map((x: string) => <li key={x}>{x}</li>)}</ul></div>}
    <textarea className="input" rows={2} placeholder={d.needsReview.length ? 'How was each review item resolved? (required)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
    <button className="btn" onClick={confirm}>Confirm final pay</button></div>);
}
export function Offboarding() {
  const staff = user().role !== 'employee';
  const [rows, load] = useLoad(staff ? '/offboarding' : '/offboarding/mine'); const [sel, setSel] = useState<number | null>(null); const [start, setStart] = useState(false); const [err, setErr] = useState('');
  if (sel) return <div><OffboardingDetail id={sel} onBack={() => { setSel(null); load(); }} />{isHR() && <FinalPayPanel id={sel} />}</div>;
  const decide = async (o: any, approve: boolean) => {
    let body: any = { approve };
    if (approve) { const r = window.prompt('Reason code to record (leave as is, or change after your review):', o.reason || 'resignation'); if (r === null) return; if (r && r !== o.reason) body.reason = r; }
    else { const note = window.prompt('Why is this being stopped? (required)') || ''; if (!note) return; body.note = note; }
    try { await api(`/offboarding/${o.id}/decide`, 'POST', body); setErr(''); } catch (e: any) { setErr(e.message); } load();
  };
  if (!staff) return (<div><Title>My resignation</Title><Propose onSaved={load} /><Loading d={rows} />
    {rows && rows.length > 0 && <Table head={['Last day', 'Status', 'HR note']}>{rows.map((o: any) => <tr key={o.id}><Td>{o.terminationDate}</Td><Td><Tag s={o.status} /></Td><Td>{o.decisionNote}</Td></tr>)}</Table>}</div>);
  return (
    <div><Title right={isHR() && <button className="btn" onClick={() => setStart(true)}>Start offboarding</button>}>Offboarding</Title>{err && <p className="alert-warn" role="alert">{err}</p>}
      {!isHR() && <Propose onSaved={load} />}<Loading d={rows} />
      {rows && (rows.length === 0 ? <div className="alert-ok">No offboarding cases.</div> :
        <Table head={['Employee', 'Last day', 'Status', 'From', 'Access', 'Progress', '']}>
          {rows.map((o: any) => (
            <tr key={o.id}><Td><b>{o.employee?.name}</b><div className="text-xs text-slate-500">{o.employee?.title}</div></Td><Td>{o.terminationDate}</Td><Td><Tag s={o.status} /></Td><Td className="capitalize">{o.initiatedBy}</Td><Td>{o.accessRevokedAt ? 'revoked' : 'active'}</Td><Td>{o.status === 'proposed' ? '—' : `${o.done} of ${o.total}`}</Td>
              <Td><span className="flex flex-wrap gap-2">{o.status === 'proposed' && isHR() && o.employeeId !== user().id && <><button className="btn !px-2 !py-1" onClick={() => decide(o, true)}>Approve</button><button className="btn-ghost !px-2 !py-1" onClick={() => decide(o, false)}>Stop</button></>}
                {isHR() && o.status !== 'proposed' && <button className="btn-ghost !py-1.5" onClick={() => setSel(o.id)}>Open</button>}</span></Td></tr>))}
        </Table>)}
      {start && <StartOffboarding onClose={() => setStart(false)} onSaved={load} />}
    </div>
  );
}
