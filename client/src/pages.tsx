import { useState, useRef, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Users, Clock, CalendarDays, Timer, UserPlus, Plane, FileText, Calculator, BarChart3, Send } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { api, useLoad, user } from './api';
import { EmployeeWizard } from './forms';

export const Title = ({ children, right }: any) => (
  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
    <h1 className="font-serif text-2xl text-navy-800">{children}</h1>
    {right}
  </div>
);

export const Table = ({ head, children }: any) => (
  <div className="card overflow-x-auto p-0">
    <table className="w-full min-w-[560px] text-left text-sm">
      <thead className="bg-slate-50 text-slate-500">
        <tr>
          {head.map((h: string) => (
            <th key={h} className="px-4 py-3 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">{children}</tbody>
    </table>
  </div>
);

export const Tag = ({ s }: { s: string }) => (
  <span className={`badge ${['approved', 'done', 'active', 'present', 'hired', 'exported', 'verified', 'complete', 'returned', 'compliant', 'open', 'accepted', 'completed', 'cleared', 'filled', 'sent'].includes(s) ? 'bg-green-100 text-green-700' : ['rejected', 'overdue', 'terminated', 'absent', 'expired', 'missing', 'declined', 'withdrawn', 'adverse', 'closed', 'cancelled'].includes(s) ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
    {s}
  </span>
);

export const Td = ({ children, className = "" }: any) => <td className={"px-4 py-3 " + className}>{children}</td>;
const isStaff = () => user().role !== 'employee';

export function Dashboard() {
  const [d] = useLoad('/dashboard');
  if (!d || !d.series) return <p className="text-slate-500">Loading...</p>;
  const annual = d.balance.find((b: any) => b.type === 'Annual') || { total: 0, used: 0, pending: 0 };
  const dd = (h: number) => Math.round(h / 8), left = dd(annual.total - annual.used - annual.pending);
  const stats: any[] = [
    ['Total Employees', d.total, Users, 'bg-blue-50', '/employees'],
    ['Present Today', d.present, Clock, 'bg-green-50', '/attendance'],
    ['Leave Requests', d.leaves, CalendarDays, 'bg-orange-50', '/leave'],
    ['Overtime Hours', d.ot + ' hrs', Timer, 'bg-violet-50', '/attendance']
  ];
  const actions: any[] = [
    ['Add Employee', UserPlus, '/employees'],
    ['Mark Attendance', Clock, '/attendance'],
    ['Request Leave', Plane, '/leave'],
    ['View Timesheets', FileText, '/timesheets'],
    ['Run Payroll', Calculator, '/payroll'],
    ['View Reports', BarChart3, '/compliance']
  ];

  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl text-navy-800 sm:text-3xl">Welcome, {user().name}! 👋</h1>
      <p className="-mt-3 text-slate-500">Here's what's happening in your organization today.</p>
      
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(([l, v, I, bg, to]) => (
          <Link to={to} key={l} className={`card ${bg}`}>
            <I size={20} className="text-brand" />
            <div className="mt-2 text-sm text-slate-600">{l}</div>
            <div className="text-2xl font-semibold">{v}</div>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="mb-2 font-semibold">Attendance Overview <span className="text-xs font-normal text-slate-400">last 30 days</span></h2>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={d.series}>
                <XAxis dataKey="date" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip />
                <Legend />
                <Line dataKey="present" stroke="#2563eb" dot={false} strokeWidth={2} />
                <Line dataKey="absent" stroke="#ef4444" dot={false} />
                <Line dataKey="leave" stroke="#22c55e" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid gap-4">
          <div className="card">
            <h2 className="mb-3 font-semibold">Quick Actions</h2>
            <div className="grid grid-cols-2 gap-2">
              {actions.map(([l, I, to]) => (
                <Link key={l} to={to} className="flex flex-col items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center text-xs hover:bg-blue-50">
                  <I size={18} className="text-brand" />
                  {l}
                </Link>
              ))}
            </div>
          </div>

          <div className="rounded-2xl bg-gradient-to-br from-navy-900 to-navy-700 p-4 text-white">
            <h2 className="font-semibold">AI HR Assistant</h2>
            <p className="my-2 text-sm text-slate-300">Get instant answers about HR policies, leave, payroll and more!</p>
            <Link to="/assistant" className="btn-ghost !text-navy-900">Chat Now</Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div className="card">
          <h2 className="mb-3 font-semibold">Recent Activity</h2>
          {d.activity.map((a: any) => (
            <div key={a.id} className="border-l-2 border-brand py-1 pl-3 text-sm">
              <div className="font-medium">{a.action}</div>
              <div className="text-xs text-slate-500">{a.detail}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <h2 className="mb-1 font-semibold">Leave Balance</h2>
          <div className="flex items-center gap-4">
            <div className="relative h-32 w-32">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={[{ v: dd(annual.used) }, { v: dd(annual.pending) }, { v: left }]} dataKey="v" innerRadius={40} outerRadius={56} stroke="none">
                    <Cell fill="#2563eb" />
                    <Cell fill="#22c55e" />
                    <Cell fill="#bfdbfe" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 grid place-items-center text-center text-xs">
                <b className="text-lg">{left}</b>Days left
              </div>
            </div>
            <ul className="text-sm">
              <li>Used: {dd(annual.used)}</li>
              <li>Scheduled: {dd(annual.pending)}</li>
              <li>Remaining: {left}</li>
            </ul>
          </div>
        </div>

        <div className="card">
          <h2 className="mb-3 font-semibold">Upcoming Events</h2>
          {d.events.map((e: any) => (
            <div key={e.id} className="flex items-center justify-between py-1.5 text-sm">
              <span>
                <b>{e.type}</b>
                <br />
                <span className="text-xs text-slate-500">{e.dueDate}</span>
              </span>
              <Tag s={e.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Admin-only: set a new temporary password. The person must change it at next login and is signed out everywhere. */
function ResetPassword({ who, onClose }: { who: any; onClose: () => void }) {
  const [f, setF] = useState({ password: '', confirmPassword: '' }); const [err, setErr] = useState(''); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  const submit = async (e: any) => { e.preventDefault(); setErr(''); if (f.password.length < 12) return setErr('Password must be at least 12 characters'); if (f.password !== f.confirmPassword) return setErr('Password and confirm password do not match');
    setBusy(true); try { await api(`/employees/${who.id}/reset-password`, 'POST', f); setDone(true); } catch (x: any) { setErr(x.message); } setBusy(false); };
  return (<div className="fixed inset-0 z-50 grid place-items-center bg-navy-950/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Reset password">
    <form onSubmit={submit} className="card w-full max-w-sm space-y-3 !p-6 shadow-2xl"><h2 className="font-serif text-xl">Reset password</h2>
      {done ? <><p className="alert-ok" role="status">Password reset for {who.name}. They are signed out everywhere and must choose a new password at next login. Share the temporary password securely.</p><button type="button" className="btn w-full" onClick={onClose}>Done</button></> : <>
        <p className="text-sm text-slate-500">{who.name} · {who.email}</p>
        <input className="input" type="password" autoComplete="new-password" placeholder="New temporary password" aria-label="New temporary password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <input className="input" type="password" autoComplete="new-password" placeholder="Confirm password" aria-label="Confirm password" value={f.confirmPassword} onChange={(e) => setF({ ...f, confirmPassword: e.target.value })} />
        {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
        <div className="flex gap-2"><button type="button" className="btn-ghost flex-1" onClick={onClose}>Cancel</button><button className="btn flex-1" disabled={busy}>Reset password</button></div></>}
    </form></div>);
}

export function Employees() {
  const [all, load] = useLoad('/employees');
  const [show, setShow] = useState(false); const [resetFor, setResetFor] = useState<any>(null);
  const [params, setParams] = useSearchParams(); const term = (params.get('q') || '').toLowerCase();
  const rows = all && all.filter((e: any) => !term || [e.name, e.email, e.department, e.title].some((v) => String(v || '').toLowerCase().includes(term)));
  return (
    <div>
      <Title right={['admin', 'hr'].includes(user().role) && <button className="btn" onClick={() => setShow(true)}>Add Employee</button>}>Employees</Title>
      {show && <EmployeeWizard onClose={() => setShow(false)} onSaved={load} />}
      <input className="input mb-3 max-w-sm" placeholder="Filter employees" aria-label="Filter employees" value={params.get('q') || ''} onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {})} />
      {resetFor && <ResetPassword who={resetFor} onClose={() => setResetFor(null)} />}
      <Table head={['Name', 'Department', 'Title', 'Type', 'Pay', 'State', 'Status', ...(user().role === 'admin' ? ['Account'] : [])]}>
        {(rows || []).map((e: any) => (
          <tr key={e.id} className="transition hover:bg-indigo-50/40">
            <Td><b>{e.name}</b><div className="text-xs text-slate-500">{e.email}</div></Td>
            <Td>{e.department}</Td><Td>{e.title}</Td><Td>{e.type.replace('_', ' ')}</Td>
            <Td>{e.payType === 'salary' ? '$' + Number(e.annualSalary).toLocaleString() + '/yr' : '$' + Number(e.hourlyRate).toFixed(2) + '/h'}</Td>
            <Td>{e.workState}</Td><Td><Tag s={e.status} /></Td>
            {user().role === 'admin' && <Td><span className="capitalize text-xs text-slate-500">{e.role}{e.mustChangePassword ? ' · must change password' : ''}</span>
              {e.id !== user().id && e.status !== 'invited' && <div><button className="text-xs text-indigo-700 underline" onClick={() => setResetFor(e)}>Reset password</button></div>}</Td>}
          </tr>
        ))}
      </Table>
    </div>
  );
}

export function Attendance() {
  const [rows, load] = useLoad('/attendance');
  return (
    <div>
      <Title right={<button className="btn" onClick={async () => { await api('/attendance/clock', 'POST'); load(); }}>Clock in / out</button>}>
        Attendance
      </Title>
      <Table head={['Date', 'Employee', 'In', 'Out', 'Hours', 'Status']}>
        {(rows || []).map((a: any) => (
          <tr key={a.id}>
            <Td>{a.date}</Td>
            <Td>#{a.employeeId}</Td>
            <Td>{a.clockIn ? new Date(a.clockIn).toLocaleTimeString() : '-'}</Td>
            <Td>{a.clockOut ? new Date(a.clockOut).toLocaleTimeString() : '-'}</Td>
            <Td>{Number(a.hours).toFixed(1)}</Td>
            <Td><Tag s={a.status} /></Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export function Leave() {
  const [rows, load] = useLoad('/leave');
  const [f, setF] = useState<any>({ type: 'Annual', hours: 8 });
  const [msg, setMsg] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: any) => {
    e.preventDefault();
    try { const r = await api('/leave', 'POST', { ...f, hours: +f.hours }); setMsg(r.status === 'rejected' ? r.comment : 'Request sent for approval'); } catch (x: any) { setMsg(x.message); }
    load();
  };
  const decide = async (id: number, approve: boolean) => {
    const comment = approve ? '' : window.prompt('Reason for rejecting (required)') || '';
    if (!approve && !comment) return;
    try { await api(`/leave/${id}/decide`, 'POST', { approve, comment }); setMsg(approve ? 'Approved' : 'Rejected'); } catch (e: any) { setMsg(e.message); }
    load();
  };

  return (
    <div>
      <Title>Leave Management</Title>
      <form onSubmit={submit} className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <select className="input" onChange={set('type')}>
          <option>Annual</option>
          <option>Sick</option>
          <option>Unpaid</option>
        </select>
        <input className="input" type="date" required onChange={set('startDate')} />
        <input className="input" type="date" required onChange={set('endDate')} />
        <input className="input" type="number" min={1} value={f.hours} onChange={set('hours')} />
        <button className="btn">Request leave</button>
        {msg && <p className="text-sm text-slate-600 sm:col-span-2 lg:col-span-5">{msg}</p>}
      </form>
      <Table head={['Employee', 'Type', 'Dates', 'Hours', 'Status', '']}>
        {(rows || []).map((l: any) => (
          <tr key={l.id}>
            <Td>{l.employeeName ?? '#' + l.employeeId}</Td>
            <Td>{l.type}</Td>
            <Td>{l.startDate} to {l.endDate}</Td>
            <Td>{l.hours}</Td>
            <Td><Tag s={l.status} /></Td>
            <Td>
              {l.status === 'pending' && isStaff() && (
                <span className="flex gap-2">
                  <button className="btn" onClick={() => decide(l.id, true)}>Approve</button>
                  <button className="btn-ghost" onClick={() => decide(l.id, false)}>Reject</button>
                </span>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export function Payroll() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [rows, load] = useLoad('/payroll?period=' + period);
  const act = (p: string) => async () => { await api(p, 'POST', { period }); load(); };
  const exp = async () => {
    const t = await api('/payroll/export?period=' + period, 'GET', undefined, true);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' }));
    a.download = `payroll-${period}.csv`;
    a.click();
    load();
  };

  return (
    <div>
      <Title right={
        <div className="flex flex-wrap gap-2">
          <input className="input !w-40" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <button className="btn" onClick={act('/payroll/generate')}>Generate</button>
          <button className="btn-ghost" onClick={act('/payroll/lock')}>Lock</button>
          <button className="btn-ghost" onClick={exp}>Export CSV</button>
        </div>
      }>
        Payroll
      </Title>
      <Table head={['Employee', 'Regular hrs', 'OT hrs', 'Gross', 'Deductions', 'Net', 'Status']}>
        {(rows || []).map((p: any) => (
          <tr key={p.id}>
            <Td>#{p.employeeId}</Td>
            <Td>{Number(p.regularHours).toFixed(1)}</Td>
            <Td>{Number(p.otHours).toFixed(1)}</Td>
            <Td>${p.gross}</Td>
            <Td>${p.deductions}</Td>
            <Td>${p.net}</Td>
            <Td><Tag s={p.status} /></Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export function Compliance() {
  const [rows, load] = useLoad('/compliance');
  return (
    <div>
      <Title>Compliance Tasks</Title>
      <Table head={['Task', 'Employee', 'Due', 'Status', '']}>
        {(rows || []).map((t: any) => (
          <tr key={t.id}>
            <Td>{t.type}</Td>
            <Td>#{t.employeeId}</Td>
            <Td>{t.dueDate}</Td>
            <Td><Tag s={t.status} /></Td>
            <Td>
              {t.status !== 'done' && (
                <button className="btn-ghost" onClick={async () => { await api(`/compliance/${t.id}/complete`, 'POST'); load(); }}>
                  Mark done
                </button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

const HELLO = { role: 'assistant', content: 'Hi! Ask me about leave balance, policies, payroll or compliance. I can prepare a leave request or a leave decision, but nothing happens until you press Confirm.' };
export function Assistant() {
  const [msgs, setMsgs] = useState<any[]>([HELLO]); const [chatId, setChatId] = useState<number | null>(null); const [chats, setChats] = useState<any[]>([]);
  const [t, setT] = useState(''); const [busy, setBusy] = useState(false); const [view, setView] = useState<'chat' | 'log'>('chat'); const [log, setLog] = useState<any[] | null>(null); const [err, setErr] = useState('');
  const end = useRef<any>(null); const isAdmin = user().role === 'admin';
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);
  const loadList = () => api('/ai/chats').then(setChats).catch(() => null);
  useEffect(() => { loadList(); }, []);
  const newChat = () => { setChatId(null); setMsgs([HELLO]); setView('chat'); setErr(''); };
  const open = async (id: number) => {
    setView('chat'); setErr('');
    try {
      const [c, pend] = await Promise.all([api(`/ai/chats/${id}`), api('/ai/actions')]); const live = new Set((pend as any[]).map((x) => x.id));
      setChatId(id); setMsgs([HELLO, ...c.messages.map((m: any) => ({ ...m, actions: (m.actions || []).map((a: any) => ({ ...a, state: live.has(a.id) ? 'pending' : 'closed' })) }))]);
    } catch (x: any) { setErr(x.message); }
  };
  const remove = async (id: number) => { if (!window.confirm('Delete this chat?')) return; try { await api(`/ai/chats/${id}`, 'DELETE'); if (id === chatId) newChat(); loadList(); } catch (x: any) { setErr(x.message); } };
  const send = async (e: any) => {
    e.preventDefault(); if (!t.trim() || busy) return;
    const next = [...msgs, { role: 'user', content: t }]; setMsgs(next); setT(''); setBusy(true); setErr('');
    try {
      const r = await api('/ai/chat', 'POST', { chatId, messages: [{ role: 'user', content: t }] });
      setChatId(r.chatId); setMsgs([...next, { role: 'assistant', content: r.reply, actions: (r.actions || []).map((a: any) => ({ ...a, state: 'pending' })) }]); loadList();
    } catch (x: any) { setMsgs([...next, { role: 'assistant', content: x.message }]); }
    setBusy(false);
  };
  const decide = async (mi: number, ai: number, kind: 'confirm' | 'cancel') => {
    const a = msgs[mi].actions[ai]; const set = (state: string, note = '') => setMsgs((cur) => cur.map((m, i) => i !== mi ? m : { ...m, actions: m.actions.map((x: any, j: number) => j === ai ? { ...x, state, note } : x) }));
    set('working');
    try { const r = await api(`/ai/actions/${a.id}/${kind}`, 'POST'); set(kind === 'confirm' ? 'done' : 'cancelled', r.message || ''); } catch (x: any) { set('error', x.message); }
  };
  const showLog = async () => { setView('log'); setErr(''); try { setLog(await api('/ai/audit')); } catch (x: any) { setErr(x.message); } };
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between"><Title>AI HR Assistant</Title>
        {isAdmin && <div className="flex gap-2"><button className={view === 'chat' ? 'btn !py-1.5' : 'btn-ghost !py-1.5'} onClick={() => setView('chat')}>Chat</button><button className={view === 'log' ? 'btn !py-1.5' : 'btn-ghost !py-1.5'} onClick={showLog}>Activity log</button></div>}</div>
      {err && <p className="mb-2 text-sm text-red-600" role="alert">{err}</p>}
      {view === 'log' ? (
        <div className="space-y-2"><p className="text-sm text-slate-500">What people asked the assistant (first 300 characters), which tools it used and which actions were proposed, confirmed or cancelled. Assistant answers are not recorded here.</p>
          {!log ? <p className="text-slate-500">Loading...</p> : log.length === 0 ? <div className="card text-center text-sm text-slate-500">Nothing recorded yet.</div> :
            <Table head={['When', 'Person', 'Type', 'Tool', 'Detail', 'OK']}>{log.map((r) => <tr key={r.id}><Td>{new Date(r.createdAt).toLocaleString()}</Td><Td>{r.userName || `#${r.userId}`}</Td><Td>{r.kind}</Td><Td>{r.tool || ''}</Td><Td>{r.detail}</Td><Td>{r.ok ? 'yes' : 'no'}</Td></tr>)}</Table>}</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
          <aside className="space-y-2">
            <button className="btn w-full" onClick={newChat}>New chat</button>
            <div className="card max-h-[28vh] space-y-1 overflow-y-auto !p-2 md:max-h-[calc(100vh-17rem)]" aria-label="Chat history">
              {chats.length === 0 && <p className="p-2 text-xs text-slate-400">Your chats will appear here.</p>}
              {chats.map((c) => (<div key={c.id} className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${c.id === chatId ? 'bg-slate-100 font-medium' : 'hover:bg-slate-50'}`}>
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => open(c.id)} title={c.title}>{c.title}</button>
                <button className="text-xs text-slate-400 hover:text-red-600" aria-label={`Delete chat ${c.title}`} onClick={() => remove(c.id)}>x</button></div>))}
            </div>
            <p className="text-xs text-slate-400">Chats are private to you and deleted after 90 days.</p>
          </aside>
          <div className="flex h-[calc(100vh-13rem)] flex-col">
            <div className="card flex-1 space-y-3 overflow-y-auto">
              {msgs.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'ml-auto max-w-[85%]' : 'max-w-[85%]'}>
                  <div className={`whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-brand text-white' : 'bg-slate-100'}`}>{m.content}</div>
                  {(m.actions || []).map((a: any, j: number) => (
                    <div key={a.id} className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm" role="group" aria-label="Action waiting for your confirmation">
                      <div className="font-medium">Please confirm</div><div className="text-slate-700">{a.summary}</div>
                      {a.state === 'pending' && <div className="mt-2 flex gap-2"><button className="btn !py-1.5" onClick={() => decide(i, j, 'confirm')}>Confirm</button><button className="btn-ghost !py-1.5" onClick={() => decide(i, j, 'cancel')}>Cancel</button></div>}
                      {a.state === 'working' && <div className="mt-2 text-slate-500">Working...</div>}
                      {a.state === 'done' && <div className="mt-2 text-green-700" role="status">Done: {a.note}</div>}
                      {a.state === 'cancelled' && <div className="mt-2 text-slate-500">Cancelled. Nothing was changed.</div>}
                      {a.state === 'closed' && <div className="mt-2 text-slate-500">No longer waiting (already decided or expired). Ask again if you still need it.</div>}
                      {a.state === 'error' && <div className="mt-2 text-red-600" role="alert">{a.note}</div>}
                    </div>))}
                </div>
              ))}
              {busy && <div className="text-sm text-slate-400">Thinking...</div>}
              <div ref={end} />
            </div>
            <form onSubmit={send} className="mt-3 flex gap-2">
              <input className="input" placeholder="Ask about leave, payroll, policies..." maxLength={2000} value={t} onChange={(e) => setT(e.target.value)} />
              <button className="btn" aria-label="Send"><Send size={16} /></button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}