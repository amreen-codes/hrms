import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Briefcase, CalendarClock, Inbox, Users, Plus, Search, MapPin, ShieldCheck, Send, CheckCircle2, ClipboardList, ArrowLeft, Building2, Mail, Gift, FileSearch, History } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { api, useLoad, user } from './api';
import { Title, Table, Tag, Td } from './pages';

const API_BASE = (import.meta as any).env.VITE_API || 'http://localhost:4000/api';
/** Upload a resume (PDF, DOC, DOCX, 5 MB). The server checks the real file type. Returns a reference used as resumeRef. */
export function ResumeUpload({ onRef }: { onRef: (ref: string) => void }) {
  const [msg, setMsg] = useState('');
  const pick = async (e: any) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setMsg('File is larger than 5 MB');
    setMsg('Uploading...');
    try {
      const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(f); });
      const d = await api('/public/resume', 'POST', { fileName: f.name, data }); onRef(d.ref); setMsg('Uploaded: ' + d.name);
    } catch (x: any) { setMsg(x.message); }
  };
  return <div className="sm:col-span-2"><label className="label">Or upload your resume (PDF, DOC, DOCX, max 5 MB)</label><input type="file" accept=".pdf,.doc,.docx" onChange={pick} className="input" />{msg && <p className="hint" role="status">{msg}</p>}</div>;
}
async function downloadResume(id: number) {
  const r = await fetch(`${API_BASE}/candidates/${id}/resume`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
  if (!r.ok) { alert((await r.json().catch(() => ({}))).error || 'Download failed'); return; }
  const url = URL.createObjectURL(await r.blob()), a = document.createElement('a'); a.href = url; a.download = `resume-${id}`; a.click(); URL.revokeObjectURL(url);
}
import { Field, Grid } from './forms';

const isHR = () => ['admin', 'hr'].includes(user()?.role);
const when = (x: any) => (x ? new Date(x).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const day = (x: any) => (x ? new Date(x).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const usd = (n: any) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const label = (s: string) => s.replace(/_/g, ' ');
const STAGE_COLOR: Record<string, string> = { received: '#94a3b8', screening: '#6366f1', interview: '#0ea5e9', offer: '#f59e0b', hired: '#10b981', talent_pool: '#a78bfa', rejected: '#f43f5e' };
const COLUMNS = ['received', 'screening', 'interview', 'offer', 'hired', 'talent_pool'];
const REJECT: Record<string, string> = { not_qualified: 'Does not meet minimum qualifications', better_fit: 'Another candidate was a stronger fit', skills_gap: 'Skills gap', verification_discrepancy: 'Work history not confirmed after clarification', no_response: 'No response', withdrew: 'Candidate withdrew', position_closed: 'Position closed' };

/** Runs an action, shows success or the server error inline. */
function useAct() {
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<any>, ok = 'Saved') => { setBusy(true); setMsg(null); try { const r = await fn(); setMsg({ ok: true, t: ok }); return r ?? true; } catch (e: any) { setMsg({ ok: false, t: e.message }); return null; } finally { setBusy(false); } };
  const box = msg && <div role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'alert-ok' : 'alert-warn !border-red-200 !bg-red-50 !text-red-700'}>{msg.t}</div>;
  return { run, busy, box, setMsg };
}
const Modal = ({ title, onClose, wide, children }: any) => (
  <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 grid place-items-center bg-navy-950/60 p-3 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className={`max-h-[94vh] w-full overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl ${wide ? 'max-w-4xl' : 'max-w-2xl'}`}>
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-serif text-xl text-navy-800">{title}</h2><button className="btn-ghost" onClick={onClose}>Close</button></div>{children}</div>
  </div>
);
const Section = ({ icon: Icon, title, children, right }: any) => (
  <section className="rounded-xl border border-slate-200 p-4"><div className="mb-3 flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold text-navy-800"><Icon size={16} className="text-brand" />{title}</h3>{right}</div>{children}</section>
);
const Stat = ({ n, l, sub }: any) => (<div className="card !p-4"><div className="font-serif text-3xl text-navy-800">{n ?? '-'}</div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{l}</div>{sub && <div className="text-xs text-slate-400">{sub}</div>}</div>);
const StageBadge = ({ s }: { s: string }) => (<span className="badge text-white" style={{ background: STAGE_COLOR[s] || '#64748b' }}>{label(s)}</span>);

// ============================================================================ main page
export function Recruitment() {
  const [tab, setTab] = useState('pipeline'); const [sum, loadSum] = useLoad('/recruitment/summary');
  const tabs: [string, string, any][] = [['pipeline', 'Pipeline', Users], ['jobs', 'Jobs', Briefcase], ...(isHR() ? [['outbox', 'Outbox', Inbox] as [string, string, any]] : [])];
  return (
    <div className="space-y-5">
      <Title right={<Link to={`/careers/${user().companySlug}`} target="_blank" className="btn-ghost"><Building2 size={16} />View careers page</Link>}>Recruitment</Title>
      {sum && sum.byStage && (<>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat n={sum.openRequisitions} l="Open jobs" sub={sum.pendingApprovals ? `${sum.pendingApprovals} awaiting approval` : undefined} /><Stat n={sum.total} l="Candidates" />
          <Stat n={sum.interviewsNext7Days} l="Interviews, next 7 days" /><Stat n={sum.avgDaysToHire == null ? '-' : sum.avgDaysToHire + 'd'} l="Avg time to hire" /><Stat n={sum.offerAcceptRate == null ? '-' : sum.offerAcceptRate + '%'} l="Offer acceptance" sub={sum.offersOut ? `${sum.offersOut} offer(s) out` : undefined} />
        </div>
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="card"><div className="label">Hiring funnel</div>
            <div className="h-44"><ResponsiveContainer><BarChart data={['received', 'screening', 'interview', 'offer', 'hired'].map((k) => ({ k: label(k), v: sum.byStage[k], c: STAGE_COLOR[k] }))} layout="vertical" margin={{ left: 12 }}><XAxis type="number" hide /><YAxis type="category" dataKey="k" width={80} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} /><Tooltip cursor={{ fill: 'rgba(99,102,241,.06)' }} /><Bar dataKey="v" radius={[0, 8, 8, 0]} barSize={16}>{['received', 'screening', 'interview', 'offer', 'hired'].map((k) => <Cell key={k} fill={STAGE_COLOR[k]} />)}</Bar></BarChart></ResponsiveContainer></div></div>
          <div className="card"><div className="label">Where candidates come from</div>
            {sum.sources.length === 0 ? <p className="text-sm text-slate-400">No applications yet.</p> : sum.sources.slice(0, 6).map((x: any) => (<div key={x.source} className="mb-2 text-sm"><div className="flex justify-between"><span>{x.source}</span><b>{x.count}</b></div><div className="h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-brand" style={{ width: `${(x.count / sum.total) * 100}%` }} /></div></div>))}</div>
        </div></>)}
      <div className="flex gap-2 overflow-x-auto border-b border-slate-200">{tabs.map(([k, l, I]) => (<button key={k} onClick={() => setTab(k)} className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${tab === k ? 'border-brand text-brand' : 'border-transparent text-slate-500 hover:text-slate-800'}`}><I size={16} />{l}{k === 'outbox' && sum?.queuedMessages ? <span className="badge bg-amber-100 text-amber-700">{sum.queuedMessages}</span> : null}</button>))}</div>
      {tab === 'pipeline' && <Pipeline onChanged={loadSum} />}{tab === 'jobs' && <Jobs onChanged={loadSum} />}{tab === 'outbox' && <Outbox onChanged={loadSum} />}
    </div>
  );
}

// ============================================================================ pipeline (kanban)
function Pipeline({ onChanged }: { onChanged: () => void }) {
  const [reqs] = useLoad('/requisitions'); const [req, setReq] = useState(''); const [q, setQ] = useState(''); const [open, setOpen] = useState<number | null>(null); const [add, setAdd] = useState(false); const [showRej, setShowRej] = useState(false);
  const [rows, load] = useLoad(`/candidates?requisitionId=${req}&q=${encodeURIComponent(q)}`); const list: any[] = Array.isArray(rows) ? rows : [];
  const changed = () => { load(); onChanged(); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input className="input !pl-9" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search candidates" /></div>
        <select className="input !w-auto" value={req} onChange={(e) => setReq(e.target.value)} aria-label="Filter by job"><option value="">All jobs</option>{(Array.isArray(reqs) ? reqs : []).map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
        {isHR() && <button className="btn" onClick={() => setAdd(true)}><Plus size={16} />Add candidate</button>}
      </div>
      {list.length === 0 && <div className="card text-center text-sm text-slate-500">No candidates yet. Publish a job, then share the careers page link, or add a referral manually.</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {COLUMNS.map((st) => { const items = list.filter((c) => c.stage === st); return (
          <div key={st} className="rounded-2xl bg-slate-100/80 p-3"><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STAGE_COLOR[st] }} />{label(st)}</h3><span className="rounded-full bg-white px-2 text-xs font-semibold text-slate-500">{items.length}</span></div>
            <div className="space-y-2">{items.map((c) => (<button key={c.id} onClick={() => setOpen(c.id)} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-indigo-100">
              <div className="flex items-start justify-between gap-2"><b className="text-sm">{c.name}</b>{c.score != null && <span className="badge bg-indigo-50 text-indigo-700">{c.score}</span>}</div>
              <div className="text-xs text-slate-500">{c.position}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-slate-500"><span className="rounded bg-slate-100 px-1.5 py-0.5">{c.source}</span>{c.duplicate && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">applied before</span>}{c.nextInterview && <span className="flex items-center gap-1 text-sky-700"><CalendarClock size={12} />{when(c.nextInterview)}</span>}</div></button>))}</div></div>); })}
      </div>
      <button className="text-sm text-slate-500 underline" onClick={() => setShowRej(!showRej)}>{showRej ? 'Hide' : 'Show'} rejected ({list.filter((c) => c.stage === 'rejected').length})</button>
      {showRej && <Table head={['Candidate', 'Job', 'Reason', '']}>{list.filter((c) => c.stage === 'rejected').map((c) => (<tr key={c.id}><Td>{c.name}</Td><Td>{c.position}</Td><Td>{label(c.rejectReason || '')}</Td><Td><button className="btn-ghost !py-1" onClick={() => setOpen(c.id)}>Open</button></Td></tr>))}</Table>}
      {open && <CandidateModal id={open} onClose={() => setOpen(null)} onChanged={changed} />}
      {add && <AddCandidate reqs={(Array.isArray(reqs) ? reqs : []).filter((r: any) => r.status === 'open')} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); changed(); }} />}
    </div>
  );
}

function AddCandidate({ reqs, onClose, onSaved }: any) {
  const a = useAct(); const [f, setF] = useState<any>({ requisitionId: reqs[0]?.id || '', source: 'Referrals', name: '', email: '', phone: '', resumeRef: '', workAuthorized: true, needsSponsorship: false, history: [{ employer: '', title: '' }], answers: {} });
  const job = reqs.find((r: any) => String(r.id) === String(f.requisitionId));
  return (
    <Modal title="Add candidate (referral, agency, direct)" onClose={onClose}>
      {reqs.length === 0 ? <p className="alert-warn">Publish a job first. Candidates can only be added to open jobs.</p> : (<div className="space-y-4">
        <Grid><Field label="Job"><select className="input" value={f.requisitionId} onChange={(e) => setF({ ...f, requisitionId: Number(e.target.value), answers: {} })}>{reqs.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></Field>
          <Field label="Source"><select className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{['Referrals', 'Staffing agency', 'Professional network', 'Job boards', 'Social media', 'Direct', 'Other'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Full name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone (optional)"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field><ResumeUpload onRef={(v) => setF({ ...f, resumeRef: v })} /><Field label="Resume link or file name"><input className="input" value={f.resumeRef} onChange={(e) => setF({ ...f, resumeRef: e.target.value })} /></Field>
          <Field label="Legally authorized to work in the US?"><select className="input" value={String(f.workAuthorized)} onChange={(e) => setF({ ...f, workAuthorized: e.target.value === 'true' })}><option value="true">Yes</option><option value="false">No</option></select></Field>
          <Field label="Will need sponsorship now or later?"><select className="input" value={String(f.needsSponsorship)} onChange={(e) => setF({ ...f, needsSponsorship: e.target.value === 'true' })}><option value="false">No</option><option value="true">Yes</option></select></Field></Grid>
        <Field label="Last employer and title" hint="Used for the work history check."><div className="grid gap-2 sm:grid-cols-2"><input className="input" placeholder="Employer" value={f.history[0].employer} onChange={(e) => setF({ ...f, history: [{ ...f.history[0], employer: e.target.value }] })} /><input className="input" placeholder="Job title" value={f.history[0].title} onChange={(e) => setF({ ...f, history: [{ ...f.history[0], title: e.target.value }] })} /></div></Field>
        {(job?.questions || []).map((qq: string, i: number) => (<Field key={i} label={qq}><textarea className="input" rows={2} value={f.answers[i] || ''} onChange={(e) => setF({ ...f, answers: { ...f.answers, [i]: e.target.value } })} /></Field>))}
        {a.box}<button className="btn" disabled={a.busy} onClick={async () => { const body = { ...f, history: f.history[0].employer ? f.history : [] }; (await a.run(() => api('/candidates', 'POST', body), 'Candidate added')) && onSaved(); }}>Add candidate</button></div>)}
    </Modal>
  );
}

// ============================================================================ candidate detail
function CandidateModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [d, load] = useLoad(`/candidates/${id}`); const a = useAct(); const hrUser = isHR();
  const [rat, setRat] = useState<any>({}); const [checks, setChecks] = useState<boolean[]>([]); const [why, setWhy] = useState(''); const [rej, setRej] = useState({ reason: 'better_fit', note: '' }); const [show, setShow] = useState<string>('');
  const [iv, setIv] = useState<any>({ scheduledAt: '', format: 'video', location: '', panel: [] }); const [people] = useLoad(hrUser ? '/interviewers' : '/search?q=zz');
  const [of, setOf] = useState<any>({ payType: 'salary', rate: '', startDate: '', deadline: '', contingencies: 'Satisfactory reference check and I-9 verification' });
  if (!d || !d.candidate) return <Modal title="Candidate" onClose={onClose}><p className="text-sm text-slate-500">Loading...</p></Modal>;
  const c = d.candidate, r = d.requisition, sc = c.screening, offer = (d.offers || [])[0], bg = d.background, active = offer && ['pending_approval', 'approved', 'sent'].includes(offer.status);
  const act = async (fn: () => Promise<any>, ok?: string) => { const x = await a.run(fn, ok); if (x) { await load(); onChanged(); } return x; };
  const crit: any[] = r?.criteria || [], quals: string[] = r?.minQuals || [];
  const bgNext: Record<string, [string, string][]> = { none: [['send_disclosure', 'Send disclosure']], disclosure_sent: [['record_authorization', 'Record signed authorization']], authorized: [['record_report', 'Record report received']], report_received: [['clear', 'Clear (no issue)'], ['pre_adverse', 'Send pre-adverse notice']], pre_adverse: [['clear', 'Clear after dispute'], ['final_adverse', 'Send final adverse notice']], adverse: [], cleared: [] };
  const moves: string[] = (d.allowed || []).filter((t: string) => t !== 'rejected' && (hrUser || (c.stage === 'interview' && t === 'offer')));
  const canReject = d.allowed?.includes('rejected') && (hrUser || c.stage === 'interview');
  return (
    <Modal title={c.name} wide onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600"><StageBadge s={c.stage} /><span>{c.position}</span><span className="text-slate-300">|</span><span>{c.email}</span>{c.phone && <><span className="text-slate-300">|</span><span>{c.phone}</span></>}<span className="text-slate-300">|</span><span>via {c.source}</span>
          <span className={`badge ${c.workAuthorized ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{c.workAuthorized ? 'work authorized' : 'not authorized'}</span>{c.needsSponsorship && <span className="badge bg-amber-100 text-amber-700">needs sponsorship</span>}</div>
        {a.box}
        {c.stage === 'rejected' && <p className="alert-warn">Rejected: {REJECT[c.rejectReason] || label(c.rejectReason || '')}</p>}
        {c.stage === 'hired' && <p className="alert-ok">Hired. Employee #{c.employeeId} is in onboarding (P5).</p>}

        <div className="grid gap-4 lg:grid-cols-2">
          <Section icon={ClipboardList} title="Application">
            {String(c.resumeRef).startsWith('file:') ? <button className="btn-ghost" onClick={() => downloadResume(c.id)}>Download resume</button> : <a className="text-sm text-brand underline break-all" href={/^https?:\/\//.test(c.resumeRef) ? c.resumeRef : undefined} target="_blank" rel="noreferrer noopener">{c.resumeRef}</a>}
            {(r?.questions || []).map((q: string, i: number) => (<div key={i} className="mt-3 text-sm"><div className="font-medium">{q}</div><div className="text-slate-600">{c.answers?.[i]}</div></div>))}
          </Section>
          <Section icon={FileSearch} title="Work history">
            {(c.history || []).length === 0 ? <p className="text-sm text-slate-400">No history provided.</p> : c.history.map((h: any, i: number) => (
              <div key={i} className="mb-3 rounded-lg bg-slate-50 p-3 text-sm"><div className="flex items-center justify-between gap-2"><div><b>{h.title}</b> at {h.employer}</div><Tag s={h.status === 'discrepancy' ? 'overdue' : h.status || 'unverified'} /></div>{h.note && <div className="text-xs text-slate-500">Note: {h.note}</div>}{h.clarification && <div className="text-xs text-slate-500">Candidate clarification: {h.clarification}</div>}
                {hrUser && !['hired', 'rejected'].includes(c.stage) && (<div className="mt-2 flex flex-wrap gap-1"><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => act(() => api(`/candidates/${id}/history/${i}`, 'POST', { status: 'verified' }), 'Marked verified')}>Verified</button>
                  <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => { const note = prompt('What does not match?'); if (note) act(() => api(`/candidates/${id}/history/${i}`, 'POST', { status: 'discrepancy', note })); }}>Discrepancy</button>
                  {h.status === 'discrepancy' && <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => { const cl = prompt('What did the candidate say when asked?'); if (cl) act(() => api(`/candidates/${id}/history/${i}`, 'POST', { status: 'discrepancy', clarification: cl })); }}>Record clarification</button>}</div>)}</div>))}
            <p className="hint">A discrepancy never rejects automatically. Ask the candidate and record the answer first.</p>
          </Section>
        </div>

        {hrUser && ['received', 'screening'].includes(c.stage) && (
          <Section icon={ClipboardList} title="Structured screening (same rubric for every applicant)" right={sc && <span className="badge bg-indigo-50 text-indigo-700">score {sc.score}</span>}>
            <div className="grid gap-3 sm:grid-cols-2">{crit.map((k) => (<Field key={k.key} label={`${k.label} (${k.weight}%)`}><select className="input" value={rat[k.key] ?? sc?.ratings?.[k.key] ?? ''} onChange={(e) => setRat({ ...rat, [k.key]: Number(e.target.value) })}><option value="">Rate 1 to 5</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}{n === 1 ? ' - weak' : n === 5 ? ' - excellent' : ''}</option>)}</select></Field>))}</div>
            {quals.length > 0 && <div className="mt-3"><div className="label">Minimum qualifications met?</div>{quals.map((qq, i) => (<label key={i} className="mb-1 flex items-center gap-2 text-sm"><input type="checkbox" checked={checks[i] ?? sc?.checks?.[i] ?? false} onChange={(e) => { const n = [...quals.map((_, j) => checks[j] ?? sc?.checks?.[j] ?? false)]; n[i] = e.target.checked; setChecks(n); }} />{qq}</label>))}</div>}
            <Field label="Job-related rationale" hint="Facts about the application only. No personal characteristics."><textarea className="input" rows={2} value={why || sc?.rationale || ''} onChange={(e) => setWhy(e.target.value)} /></Field>
            <button className="btn mt-3" disabled={a.busy} onClick={() => act(() => api(`/candidates/${id}/screen`, 'POST', { ratings: { ...(sc?.ratings || {}), ...rat }, checks: quals.map((_, i) => checks[i] ?? sc?.checks?.[i] ?? false), rationale: why || sc?.rationale || '' }), 'Screening saved')}>Save screening</button>
          </Section>)}

        {(hrUser || c.stage === 'interview') && !['hired', 'rejected'].includes(c.stage) && (
          <Section icon={Send} title="Move candidate">
            <div className="flex flex-wrap items-center gap-2">{moves.map((t) => (<button key={t} className="btn-ghost" disabled={a.busy} onClick={() => act(() => api(`/candidates/${id}/move`, 'POST', { to: t }), `Moved to ${label(t)}`)}>{t === 'offer' && !hrUser ? 'Approve for offer' : `Move to ${label(t)}`}</button>))}
              {canReject && <button className="btn-ghost !border-red-200 !text-red-700" onClick={() => setShow(show === 'reject' ? '' : 'reject')}>Reject...</button>}</div>
            {c.stage === 'interview' && !d.readiness?.ok && <p className="hint">Offer is locked: {d.readiness?.reason}</p>}
            {show === 'reject' && (<div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><select className="input" value={rej.reason} onChange={(e) => setRej({ ...rej, reason: e.target.value })}>{Object.entries(REJECT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><input className="input" placeholder="Internal note (optional)" value={rej.note} onChange={(e) => setRej({ ...rej, note: e.target.value })} /><button className="btn !bg-none !bg-red-600" onClick={() => act(() => api(`/candidates/${id}/move`, 'POST', { to: 'rejected', ...rej }), 'Rejected. A respectful email is queued.')}>Confirm</button></div>)}
          </Section>)}

        {(c.stage === 'interview' || (d.interviews || []).length > 0) && (
          <Section icon={CalendarClock} title="Interviews and scorecards" right={d.panel?.count ? <span className="badge bg-indigo-50 text-indigo-700">{d.panel.count} scorecard(s), avg {d.panel.avg}</span> : null}>
            {(d.interviews || []).map((i: any) => (<div key={i.id} className="mb-3 rounded-lg bg-slate-50 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><b>{when(i.scheduledAt)}</b> <span className="text-slate-500">{i.format}{i.location ? `, ${i.location}` : ''}</span></div><div className="flex items-center gap-2"><Tag s={i.status} />{hrUser && i.status === 'scheduled' && <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => act(() => api(`/interviews/${i.id}/cancel`, 'POST'), 'Interview cancelled')}>Cancel</button>}</div></div>
              <div className="text-xs text-slate-500">Panel: {i.panel.map((p: any) => p.name).join(', ')}</div>
              {i.cardsHidden ? <p className="hint">Scorecards stay hidden until you submit yours, so scoring is independent.</p> : i.scorecards.map((s: any) => (<div key={s.id} className="mt-2 rounded-lg border border-slate-200 bg-white p-2"><div className="flex items-center justify-between"><b>{s.interviewerName}</b><span><span className="badge mr-1 bg-indigo-50 text-indigo-700">{s.total}</span><Tag s={['strong_yes', 'yes'].includes(s.recommendation) ? 'approved' : 'rejected'} /> <span className="text-xs">{label(s.recommendation)}</span></span></div><div className="text-xs text-slate-600">{s.notes}</div></div>))}</div>))}
            {hrUser && c.stage === 'interview' && (<div className="rounded-lg border border-dashed border-slate-300 p-3"><div className="label">Schedule an interview</div><div className="grid gap-2 sm:grid-cols-3"><input className="input" type="datetime-local" value={iv.scheduledAt} onChange={(e) => setIv({ ...iv, scheduledAt: e.target.value })} /><select className="input" value={iv.format} onChange={(e) => setIv({ ...iv, format: e.target.value })}><option value="video">Video</option><option value="phone">Phone</option><option value="onsite">On site</option></select><input className="input" placeholder="Link or room" value={iv.location} onChange={(e) => setIv({ ...iv, location: e.target.value })} /></div>
              <div className="mt-2"><div className="label">Panel (pick 1 to 6)</div><div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">{(Array.isArray(people) ? people : []).map((p: any) => { const on = iv.panel.includes(p.id); return <button key={p.id} type="button" onClick={() => setIv({ ...iv, panel: on ? iv.panel.filter((x: number) => x !== p.id) : [...iv.panel, p.id] })} className={`rounded-full border px-3 py-1 text-xs ${on ? 'border-brand bg-indigo-50 text-brand' : 'border-slate-300'}`}>{p.name}</button>; })}</div></div>
              <button className="btn mt-3" disabled={a.busy} onClick={() => act(() => api(`/candidates/${id}/interviews`, 'POST', { ...iv, scheduledAt: iv.scheduledAt ? new Date(iv.scheduledAt).toISOString() : '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone }), 'Interview scheduled. Invitation queued.')}>Schedule and send invitation</button></div>)}
          </Section>)}

        {['offer', 'hired'].includes(c.stage) || (d.offers || []).length > 0 ? (
          <Section icon={Gift} title="Offer">
            {offer && (<div className="mb-3 rounded-lg bg-slate-50 p-3 text-sm"><div className="flex items-center justify-between"><b>{offer.title}: {usd(offer.rate)}{offer.payType === 'hourly' ? ' / hour' : ' / year'}</b><Tag s={offer.status} /></div><div className="text-xs text-slate-500">Starts {offer.startDate}, reply by {offer.deadline}{offer.contingencies ? `. Contingent on: ${offer.contingencies}` : ''}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {offer.status === 'pending_approval' && offer.createdBy !== user().id && <><button className="btn" onClick={() => act(() => api(`/offers/${offer.id}/approve`, 'POST', { approve: true }), 'Offer approved')}>Approve terms</button><button className="btn-ghost" onClick={() => act(() => api(`/offers/${offer.id}/approve`, 'POST', { approve: false }), 'Offer returned')}>Return</button></>}
                {offer.status === 'pending_approval' && offer.createdBy === user().id && <span className="hint">Waiting for the hiring manager or another HR admin to approve.</span>}
                {hrUser && offer.status === 'approved' && <button className="btn" onClick={() => act(() => api(`/offers/${offer.id}/send`, 'POST'), 'Offer letter queued in the outbox')}><Mail size={16} />Send offer letter</button>}
                {hrUser && offer.status === 'sent' && <><button className="btn" onClick={async () => { const x: any = await act(() => api(`/offers/${offer.id}/respond`, 'POST', { accepted: true }), 'Accepted. Employee created and onboarding started.'); if (x?.tempPassword) alert(`Temporary password for the new hire (shown once):\n\n${x.tempPassword}`); }}>Candidate accepted</button><button className="btn-ghost" onClick={() => act(() => api(`/offers/${offer.id}/respond`, 'POST', { accepted: false }), 'Offer declined recorded')}>Candidate declined</button></>}</div></div>)}
            {hrUser && c.stage === 'offer' && !active && (<div><div className="label">Draft offer terms</div><Grid><Field label="Pay type"><select className="input" value={of.payType} onChange={(e) => setOf({ ...of, payType: e.target.value })}><option value="salary">Salary (per year)</option><option value="hourly">Hourly</option></select></Field><Field label="Amount" hint={r?.payMin != null ? `Posted range: ${usd(r.payMin)} to ${usd(r.payMax)}` : undefined}><input className="input" type="number" min={1} value={of.rate} onChange={(e) => setOf({ ...of, rate: e.target.value })} /></Field>
              <Field label="Start date"><input className="input" type="date" value={of.startDate} onChange={(e) => setOf({ ...of, startDate: e.target.value })} /></Field><Field label="Respond by"><input className="input" type="date" value={of.deadline} onChange={(e) => setOf({ ...of, deadline: e.target.value })} /></Field>
              <Field label="Contingencies" span={2}><input className="input" value={of.contingencies} onChange={(e) => setOf({ ...of, contingencies: e.target.value })} /></Field></Grid>
              <button className="btn mt-3" disabled={a.busy} onClick={() => act(() => api(`/candidates/${id}/offer`, 'POST', { ...of, title: r?.title }), 'Offer drafted. The hiring manager must approve the terms.')}>Submit offer for approval</button></div>)}
          </Section>) : null}

        {hrUser && !['hired', 'rejected', 'received'].includes(c.stage) && (
          <Section icon={ShieldCheck} title="Background check (FCRA steps)" right={<Tag s={bg?.status === 'cleared' ? 'approved' : bg?.status === 'adverse' ? 'rejected' : bg ? 'pending' : 'none'} />}>
            <p className="text-sm text-slate-600">Status: <b>{label(bg?.status || 'not started')}</b>. A report is never ordered without the signed, separate authorization. After a pre-adverse notice, a 5 business day wait applies before the final notice.</p>
            <div className="mt-2 flex flex-wrap gap-2">{(bgNext[bg?.status || 'none'] || []).map(([k, l]) => (<button key={k} className="btn-ghost" disabled={a.busy} onClick={() => act(() => api(`/candidates/${id}/background`, 'POST', { action: k }), l + ' done')}>{l}</button>))}</div>
          </Section>)}

        <div className="grid gap-4 lg:grid-cols-2">
          <Section icon={History} title="Stage history">{(d.timeline || []).map((t: any) => (<div key={t.id} className="mb-2 border-l-2 border-slate-200 pl-3 text-sm"><div><b>{label(t.toStage)}</b> <span className="text-xs text-slate-400">by {t.actorName}</span></div><div className="text-xs text-slate-500">{when(t.createdAt)}{t.reason ? `: ${t.reason}` : ''}</div></div>))}</Section>
          {hrUser && <Section icon={Mail} title="Candidate emails">{(d.messages || []).length === 0 ? <p className="text-sm text-slate-400">None yet.</p> : d.messages.map((m: any) => (<div key={m.id} className="mb-2 text-sm"><div className="flex items-center justify-between gap-2"><span className="font-medium">{m.subject}</span><Tag s={m.status === 'sent' ? 'done' : 'open'} /></div></div>))}</Section>}
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================ jobs (requisitions)
function Jobs({ onChanged }: { onChanged: () => void }) {
  const [rows, load] = useLoad('/requisitions'); const a = useAct(); const [nw, setNw] = useState(false); const [pub, setPub] = useState<any>(null); const list: any[] = Array.isArray(rows) ? rows : [];
  const go = async (fn: () => Promise<any>, ok: string) => { if (await a.run(fn, ok)) { load(); onChanged(); } };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-500">Draft, submit for approval, then HR publishes to the careers page.</p><button className="btn" onClick={() => setNw(true)}><Plus size={16} />New job requisition</button></div>
      {a.box}
      <Table head={['Job', 'Where', 'Pay range', 'Openings', 'Candidates', 'Status', '']}>
        {list.map((r) => (<tr key={r.id}><Td><b>{r.title}</b><div className="text-xs text-slate-500">{r.department}, requested by {r.requesterName}</div>{r.decisionNote && <div className="text-xs text-amber-700">Note: {r.decisionNote}</div>}</Td><Td>{r.city ? r.city + ', ' : ''}{r.workState}</Td><Td>{r.payMin != null ? `${usd(r.payMin)} to ${usd(r.payMax)}` : '-'}</Td><Td>{r.hired}/{r.headcount}</Td><Td>{r.activeCandidates}</Td><Td><Tag s={r.status} /></Td>
          <Td><div className="flex flex-wrap gap-1">
            {['draft', 'rejected'].includes(r.status) && <button className="btn !px-2 !py-1 text-xs" onClick={() => go(() => api(`/requisitions/${r.id}/submit`, 'POST'), 'Submitted for approval')}>Submit</button>}
            {isHR() && r.status === 'pending_approval' && r.requestedBy !== user().id && <><button className="btn !px-2 !py-1 text-xs" onClick={() => go(() => api(`/requisitions/${r.id}/decision`, 'POST', { approve: true }), 'Approved')}>Approve</button><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => { const c = prompt('Why is it returned?'); if (c) go(() => api(`/requisitions/${r.id}/decision`, 'POST', { approve: false, comment: c }), 'Returned'); }}>Return</button></>}
            {isHR() && ['approved', 'on_hold'].includes(r.status) && <button className="btn !px-2 !py-1 text-xs" onClick={() => setPub(r)}>Publish</button>}
            {isHR() && r.status === 'open' && <><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => go(() => api(`/requisitions/${r.id}/close`, 'POST', { to: 'on_hold' }), 'On hold')}>Hold</button><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => go(() => api(`/requisitions/${r.id}/close`, 'POST', { to: 'closed' }), 'Closed')}>Close</button></>}
          </div></Td></tr>))}
      </Table>
      {nw && <NewReq onClose={() => setNw(false)} onSaved={() => { setNw(false); load(); onChanged(); }} />}
      {pub && <Modal title={`Publish: ${pub.title}`} onClose={() => setPub(null)}><Publish r={pub} onDone={() => { setPub(null); load(); onChanged(); }} /></Modal>}
    </div>
  );
}
function Publish({ r, onDone }: any) {
  const a = useAct(); const all = ['Careers page', 'Job boards', 'Professional network', 'Staffing agency', 'Referrals', 'Social media']; const [ch, setCh] = useState<string[]>(['Careers page']); const [closes, setCloses] = useState('');
  return (<div className="space-y-3"><div className="label">Advertising channels</div><div className="flex flex-wrap gap-2">{all.map((c) => (<button key={c} type="button" onClick={() => setCh(ch.includes(c) ? ch.filter((x) => x !== c) : [...ch, c])} className={`rounded-full border px-3 py-1.5 text-sm ${ch.includes(c) ? 'border-brand bg-indigo-50 text-brand' : 'border-slate-300'}`}>{c}</button>))}</div>
    <Field label="Closing date (optional)"><input className="input" type="date" value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
    <p className="hint">The same job description and application link are used on every channel. Pay range rules for {r.workState} are checked when you publish.</p>{a.box}<button className="btn" disabled={a.busy} onClick={async () => (await a.run(() => api(`/requisitions/${r.id}/publish`, 'POST', { channels: ch, closesAt: closes || undefined }), 'Published')) && setTimeout(onDone, 600)}>Publish job</button></div>);
}
function NewReq({ onClose, onSaved }: any) {
  const a = useAct(); const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
  const [f, setF] = useState<any>({ title: '', department: '', workState: 'TX', city: '', employmentType: 'full_time', payType: 'salary', payMin: '', payMax: '', headcount: 1, justification: '', description: '', quals: '', questions: '' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value }); const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <Modal title="New job requisition" onClose={onClose} wide>
      <div className="space-y-4"><Grid><Field label="Job title"><input className="input" value={f.title} onChange={set('title')} /></Field><Field label="Department"><input className="input" value={f.department} onChange={set('department')} /></Field>
        <Field label="Work state"><select className="input" value={f.workState} onChange={set('workState')}>{STATES.map((s) => <option key={s}>{s}</option>)}</select></Field><Field label="City"><input className="input" value={f.city} onChange={set('city')} /></Field>
        <Field label="Type"><select className="input" value={f.employmentType} onChange={set('employmentType')}><option value="full_time">Full time</option><option value="part_time">Part time</option></select></Field><Field label="Openings"><input className="input" type="number" min={1} max={50} value={f.headcount} onChange={set('headcount')} /></Field>
        <Field label="Pay basis"><select className="input" value={f.payType} onChange={set('payType')}><option value="salary">Salary per year</option><option value="hourly">Hourly</option></select></Field><div className="grid grid-cols-2 gap-2"><Field label="Pay from"><input className="input" type="number" value={f.payMin} onChange={set('payMin')} /></Field><Field label="Pay to"><input className="input" type="number" value={f.payMax} onChange={set('payMax')} /></Field></div></Grid>
        <Field label="Why is this headcount needed?"><input className="input" value={f.justification} onChange={set('justification')} /></Field>
        <Field label="Job description (duties, essential qualifications)"><textarea className="input" rows={4} value={f.description} onChange={set('description')} /></Field>
        <Grid><Field label="Minimum qualifications (one per line)"><textarea className="input" rows={3} value={f.quals} onChange={set('quals')} /></Field><Field label="Screening questions (one per line)" hint="Checked against restricted topics: age, religion, family, health, citizenship, salary history."><textarea className="input" rows={3} value={f.questions} onChange={set('questions')} /></Field></Grid>
        {a.box}<button className="btn" disabled={a.busy} onClick={async () => (await a.run(() => api('/requisitions', 'POST', { ...f, minQuals: lines(f.quals), questions: lines(f.questions) }), 'Saved as draft')) && onSaved()}>Save draft</button></div>
    </Modal>
  );
}

// ============================================================================ outbox
function Outbox({ onChanged }: { onChanged: () => void }) {
  const [rows, load] = useLoad('/recruitment/messages'); const [open, setOpen] = useState<number | null>(null); const list: any[] = Array.isArray(rows) ? rows : [];
  return (
    <div className="space-y-3"><p className="text-sm text-slate-500">Every candidate email is written from an approved template and waits here. Send it with one click when e-mail (SMTP) is configured, or copy it into your mail system and mark it sent.</p>
      {list.length === 0 && <div className="card text-center text-sm text-slate-500">Nothing waiting. Inbox zero.</div>}
      {list.map((m) => (<div key={m.id} className="card !p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-medium">{m.subject}</div><div className="text-xs text-slate-500">To {m.toEmail} | {label(m.kind)} | {when(m.createdAt)}</div></div>
        <div className="flex gap-2"><button className="btn-ghost !py-1.5" onClick={() => setOpen(open === m.id ? null : m.id)}>{open === m.id ? 'Hide' : 'Preview'}</button><button className="btn-ghost !py-1.5" onClick={async () => { try { await api(`/recruitment/messages/${m.id}/send`, 'POST'); load(); onChanged(); } catch (e: any) { window.alert(e.message); } }}>Send email</button><button className="btn !py-1.5" onClick={async () => { await api(`/recruitment/messages/${m.id}/sent`, 'POST'); load(); onChanged(); }}><CheckCircle2 size={16} />Mark sent</button></div></div>
        {open === m.id && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-sm text-slate-700">{m.body}</pre>}</div>))}
    </div>
  );
}

// ============================================================================ my interviews (every employee who is on a panel)
export function MyInterviews() {
  const [d, load] = useLoad('/my/interviews'); const [open, setOpen] = useState<any>(null); const list: any[] = d?.interviews || [];
  return (
    <div className="space-y-4"><Title>My interviews</Title>
      <p className="text-sm text-slate-500">Score each candidate on your own before the group discussion. Other panelists&apos; scores stay hidden until you submit.</p>
      {d && list.length === 0 && <div className="card text-center text-sm text-slate-500">You have no interviews assigned.</div>}
      <div className="grid gap-3 md:grid-cols-2">{list.map((i) => (<div key={i.id} className="card"><div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{i.candidate?.name}</div><div className="text-sm text-slate-500">{i.candidate?.position}</div></div><Tag s={i.submitted ? 'done' : 'open'} /></div>
        <div className="mt-2 flex items-center gap-2 text-sm text-slate-600"><CalendarClock size={16} />{when(i.scheduledAt)} <span className="text-slate-400">({i.format})</span></div>{i.location && <div className="flex items-center gap-2 text-sm text-slate-600 break-all"><MapPin size={16} />{i.location}</div>}
        {!i.submitted ? <button className="btn mt-3" onClick={() => setOpen(i)}>Submit scorecard</button> : <p className="hint mt-3">Your scorecard is in: {i.myCard?.total} points, {label(i.myCard?.recommendation || '')}.</p>}</div>))}</div>
      {open && <ScoreModal iv={open} comps={d.competencies} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load(); }} />}
    </div>
  );
}
function ScoreModal({ iv, comps, onClose, onSaved }: any) {
  const a = useAct(); const [sc, setSc] = useState<any>({}); const [rec, setRec] = useState(''); const [notes, setNotes] = useState('');
  return (<Modal title={`Scorecard: ${iv.candidate?.name}`} onClose={onClose}><div className="space-y-4">
    {comps.map((k: any) => (<div key={k.key}><div className="label">{k.label}</div><div className="flex gap-2">{[1, 2, 3, 4, 5].map((n) => (<button key={n} type="button" onClick={() => setSc({ ...sc, [k.key]: n })} className={`h-10 w-10 rounded-xl border text-sm font-semibold ${sc[k.key] === n ? 'border-brand bg-brand text-white' : 'border-slate-300 hover:bg-slate-50'}`} aria-label={`${k.label} ${n}`}>{n}</button>))}</div></div>))}
    <Field label="Recommendation"><select className="input" value={rec} onChange={(e) => setRec(e.target.value)}><option value="">Choose</option><option value="strong_yes">Strong yes</option><option value="yes">Yes</option><option value="no">No</option><option value="strong_no">Strong no</option></select></Field>
    <Field label="Evidence notes" hint="Describe what the candidate said or did that relates to the job. No personal characteristics."><textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    {a.box}<button className="btn" disabled={a.busy} onClick={async () => (await a.run(() => api(`/interviews/${iv.id}/scorecard`, 'POST', { scores: sc, recommendation: rec, notes }), 'Submitted')) && setTimeout(onSaved, 500)}>Submit scorecard</button></div></Modal>);
}

// ============================================================================ public careers page (no login)
const Shellc = ({ children }: any) => (
  <div className="min-h-screen bg-slate-50"><header className="bg-gradient-to-br from-navy-950 via-navy-900 to-indigo-900 px-4 py-14 text-white"><div className="mx-auto max-w-4xl"><div className="text-xs font-semibold uppercase tracking-widest text-gold-400">Careers at AMS</div><h1 className="mt-2 font-serif text-4xl">Build your career with us</h1><p className="mt-2 max-w-xl text-slate-300">Open roles across the United States. We are an equal opportunity employer and welcome reasonable accommodation requests at any step.</p></div></header>
    <main className="mx-auto max-w-4xl p-4 sm:p-6">{children}</main><footer className="flex items-center justify-center gap-2 p-6 text-xs text-slate-400"><span>Powered by</span><img src="/logo.png" alt="HRMS" className="h-6 w-auto" /></footer></div>
);
export function Careers() {
  return (<Routes><Route path="/careers/:slug" element={<Jobsite />} /><Route path="/careers/:slug/:id" element={<JobPage />} /></Routes>);
}
function Jobsite() {
  const { slug } = useParams(); const [jobs] = useLoad(`/public/${slug}/jobs`); const [q, setQ] = useState(''); const list: any[] = (Array.isArray(jobs) ? jobs : []).filter((j) => (j.title + j.department + j.city + j.state).toLowerCase().includes(q.toLowerCase()));
  return (<Shellc><div className="relative mb-4"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input className="input !pl-9" placeholder="Search roles, teams or locations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search jobs" /></div>
    {jobs && list.length === 0 && <div className="card text-center text-slate-500">No open roles right now. Please check back soon.</div>}
    <div className="space-y-3">{list.map((j) => (<Link key={j.id} to={`/careers/${slug}/${j.id}`} className="card block !p-5 transition hover:-translate-y-0.5 hover:shadow-lg"><div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-serif text-xl text-navy-800">{j.title}</h2><div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500"><span className="flex items-center gap-1"><Building2 size={14} />{j.department}</span><span className="flex items-center gap-1"><MapPin size={14} />{j.city ? j.city + ', ' : ''}{j.state}</span><span className="capitalize">{label(j.employmentType)}</span></div></div>
      {j.payMin != null && <span className="badge bg-emerald-50 text-emerald-700 !text-sm">{usd(j.payMin)} to {usd(j.payMax)}{j.payType === 'hourly' ? ' / hour' : ' / year'}</span>}</div></Link>))}</div></Shellc>);
}
function JobPage() {
  const { id, slug } = useParams(); const nav = useNavigate(); const [j, setJ] = useState<any>(null); const [err, setErr] = useState(''); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  const [f, setF] = useState<any>({ name: '', email: '', phone: '', resumeRef: '', workAuthorized: '', needsSponsorship: '', employer: '', title: '', answers: {}, consent: false, website: '' });
  useEffect(() => { api(`/public/${slug}/jobs/${id}`).then(setJ).catch(() => setJ(false)); }, [id]);
  if (j === false) return <Shellc><div className="card text-center">This job is no longer open. <Link to={`/careers/${slug}`} className="text-brand underline">See all roles</Link></div></Shellc>;
  if (!j) return <Shellc><p className="text-slate-500">Loading...</p></Shellc>;
  const submit = async (e: any) => { e.preventDefault(); setErr(''); if (f.workAuthorized === '' || f.needsSponsorship === '') return setErr('Please answer both work authorization questions.'); setBusy(true);
    try { await api(`/public/${slug}/jobs/${id}/apply`, 'POST', { name: f.name, email: f.email, phone: f.phone, resumeRef: f.resumeRef, workAuthorized: f.workAuthorized === 'yes', needsSponsorship: f.needsSponsorship === 'yes', history: f.employer ? [{ employer: f.employer, title: f.title }] : [], answers: f.answers, consent: f.consent, website: f.website, source: 'Careers page' }); setDone(true); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return (<Shellc><button className="mb-3 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800" onClick={() => nav(`/careers/${slug}`)}><ArrowLeft size={16} />All roles</button>
    <div className="card !p-6"><h1 className="font-serif text-3xl text-navy-800">{j.title}</h1><div className="mt-2 flex flex-wrap gap-x-4 text-sm text-slate-500"><span>{j.department}</span><span>{j.city ? j.city + ', ' : ''}{j.state}</span><span className="capitalize">{label(j.employmentType)}</span>{j.payMin != null && <b className="text-emerald-700">{usd(j.payMin)} to {usd(j.payMax)}{j.payType === 'hourly' ? ' / hour' : ' / year'}</b>}</div>
      <p className="mt-4 whitespace-pre-wrap text-slate-700">{j.description}</p>{j.minQuals.length > 0 && <><h3 className="mt-4 text-sm font-semibold">Minimum qualifications</h3><ul className="ml-5 list-disc text-sm text-slate-700">{j.minQuals.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></>}</div>
    {done ? (<div className="card mt-5 !p-8 text-center"><CheckCircle2 size={40} className="mx-auto text-emerald-500" /><h2 className="mt-3 font-serif text-2xl">Application received</h2><p className="mt-1 text-slate-600">Thank you. We will review it against the job requirements and email you about next steps.</p><Link to="/careers" className="btn mt-4">See other roles</Link></div>) : (
      <form onSubmit={submit} className="card mt-5 space-y-4 !p-6"><h2 className="font-serif text-2xl">Apply for this role</h2>
        <Grid><Field label="Full name"><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field><Field label="Email"><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
          <Field label="Phone (optional)"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" /></Field><ResumeUpload onRef={(v) => setF({ ...f, resumeRef: v })} /><Field label="Resume link or file name" hint="Paste a link to your resume (Drive, Dropbox, LinkedIn)."><input className="input" required value={f.resumeRef} onChange={(e) => setF({ ...f, resumeRef: e.target.value })} /></Field>
          <Field label="Most recent employer"><input className="input" value={f.employer} onChange={(e) => setF({ ...f, employer: e.target.value })} /></Field><Field label="Most recent job title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Are you legally authorized to work in the United States?"><select className="input" required value={f.workAuthorized} onChange={(e) => setF({ ...f, workAuthorized: e.target.value })}><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></Field>
          <Field label="Will you now or in the future need employer sponsorship?"><select className="input" required value={f.needsSponsorship} onChange={(e) => setF({ ...f, needsSponsorship: e.target.value })}><option value="">Choose</option><option value="no">No</option><option value="yes">Yes</option></select></Field></Grid>
        {j.questions.map((qq: string, i: number) => (<Field key={i} label={qq}><textarea className="input" rows={3} required value={f.answers[i] || ''} onChange={(e) => setF({ ...f, answers: { ...f.answers, [i]: e.target.value } })} /></Field>))}
        <div className="hidden" aria-hidden="true"><input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></div>
        <label className="flex items-start gap-2 text-sm text-slate-600"><input type="checkbox" className="mt-1" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />I agree that AMS may store and process my application to consider me for this and similar roles. I can ask for correction or deletion at any time.</label>
        <p className="text-xs text-slate-500">Need an accommodation to apply? Contact {j.accommodationContact}. Please do not include photos, age, or other personal characteristics in your resume.</p>
        {err && <p role="alert" className="alert-warn !border-red-200 !bg-red-50 !text-red-700">{err}</p>}<button className="btn w-full sm:w-auto" disabled={busy}>{busy ? 'Sending...' : 'Submit application'}</button></form>)}
  </Shellc>);
}
