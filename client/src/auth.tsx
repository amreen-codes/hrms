import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { api, useLoad } from './api';
import { Logo } from './brand';
import { Title, Table, Tag, Td } from './pages';

/** Reads the session (cookie) and caches non-sensitive display info for the UI. Real authorization is always server-side. */
export async function loadMe() {
  const m = await api('/auth/me');
  if (m.mustChangePassword) return { pending: true, me: m };   // an Admin set or reset this password: it must be changed before anything else
  localStorage.setItem('user', JSON.stringify({ ...m.user, companySlug: m.company?.slug, companyName: m.company?.name, plan: m.company?.plan }));
  return { pending: false, me: m };
}
export async function doLogout() { await api('/auth/logout', 'POST').catch(() => {}); localStorage.clear(); location.reload(); }

const card = 'min-h-screen grid place-items-center bg-gradient-to-br from-navy-950 via-navy-900 to-indigo-900 p-4';
export function Login({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ email: '', password: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: any) => { e.preventDefault(); setBusy(true); setErr('');
    try { await api('/auth/login', 'POST', f); await loadMe(); onDone(); } catch (x: any) { setErr(x.message); } setBusy(false); };
  return (<div className={card}><div className="card w-full max-w-sm space-y-4 !p-8 shadow-2xl">
    <div className="-mt-1 mb-1 flex justify-center"><Logo className="h-16 w-auto max-w-full" /></div>
    <form onSubmit={submit} className="space-y-4"><h1 className="font-serif text-3xl">Welcome back</h1><p className="text-sm text-slate-500">HR Management System</p>
      <input className="input" type="email" autoComplete="username" placeholder="Email" aria-label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <input className="input" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}<button className="btn w-full" disabled={busy || !f.email || !f.password}>Sign in</button></form>
  </div></div>);
}

/** Shown right after sign-in when an Admin set or reset the password: nothing else is reachable until it is changed. */
export function ForceChangePassword({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const bad = f.next.length < 12 ? 'New password must be at least 12 characters' : f.next !== f.confirm ? 'The new passwords do not match' : f.next === f.current ? 'Choose a different password from the one you were given' : '';
  const submit = async (e: any) => { e.preventDefault(); if (bad) return setErr(bad); setBusy(true); setErr('');
    try { await api('/auth/change-password', 'POST', f); await loadMe(); onDone(); } catch (x: any) { setErr(x.message); } setBusy(false); };
  return (<div className={card}><div className="card w-full max-w-sm space-y-4 !p-8 shadow-2xl">
    <div className="-mt-1 mb-1 flex justify-center"><Logo className="h-16 w-auto max-w-full" /></div>
    <form onSubmit={submit} className="space-y-4"><h1 className="font-serif text-2xl">Choose a new password</h1>
      <p className="text-sm text-slate-500">Your administrator gave you a temporary password. Set your own now (at least 12 characters) to continue.</p>
      <input className="input" type="password" autoComplete="current-password" placeholder="Temporary password" aria-label="Temporary password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password" aria-label="New password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
      <input className="input" type="password" autoComplete="new-password" placeholder="Repeat new password" aria-label="Repeat new password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <button className="btn w-full" disabled={busy || !f.current || !f.next}>Save and continue</button>
      <button type="button" className="w-full text-xs text-slate-500 underline" onClick={doLogout}>Sign out</button></form>
  </div></div>);
}

export function AcceptInvite() {
  const token = new URLSearchParams(location.search).get('token') || ''; const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [err, setErr] = useState(''); const [done, setDone] = useState(false);
  const go = async (e: any) => { e.preventDefault(); setErr(''); if (pw !== pw2) return setErr('Passwords do not match'); try { await api('/auth/accept-invite', 'POST', { token, password: pw }); setDone(true); } catch (x: any) { setErr(x.message); } };
  return (<div className={card}><div className="card w-full max-w-sm space-y-4 !p-8 shadow-2xl"><div className="-mt-1 mb-1 flex justify-center"><Logo className="h-16 w-auto max-w-full" /></div>
    {done ? <><h1 className="font-serif text-2xl">You’re all set</h1><p className="text-sm text-slate-500">Your password is saved. You can sign in now.</p><a className="btn w-full" href="/">Go to sign in</a></> :
      <form onSubmit={go} className="space-y-4"><h1 className="font-serif text-2xl">Accept your invitation</h1><p className="text-sm text-slate-500">Choose a password (at least 12 characters).</p>
        <input className="input" type="password" autoComplete="new-password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <input className="input" type="password" autoComplete="new-password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {err && <p className="text-sm text-red-600" role="alert">{err}</p>}<button className="btn w-full" disabled={pw.length < 12}>Save password</button></form>}
  </div></div>);
}

/** Super Admin console: create companies, assign plans, invite the first admin, suspend. */
export function Platform() {
  const [cos, load] = useLoad('/platform/companies'); const [f, setF] = useState({ name: '', slug: '', adminName: '', adminEmail: '', plan: 'starter' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<any>, ok: (r: any) => string) => { try { const r = await fn(); setMsg({ ok: true, text: ok(r) }); load(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } };
  const list: any[] = Array.isArray(cos) ? cos : [];
  return (<div className="space-y-5"><Title>Companies</Title>
    {msg && <p className={msg.ok ? 'alert-ok' : 'alert-warn'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    <div className="card space-y-3"><h2 className="font-semibold">Create a company</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input className="input" placeholder="Company name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className="input" placeholder="slug (careers URL)" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} />
        <input className="input" placeholder="Admin name" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} />
        <input className="input" type="email" placeholder="Admin email" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} />
        <select className="input" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{['starter', 'growth', 'professional', 'enterprise'].map((p) => <option key={p}>{p}</option>)}</select></div>
      <button className="btn" onClick={() => run(() => api('/platform/companies', 'POST', f), (r) => `Created. ${r.emailed ? 'The invitation was emailed to the admin. ' : 'E-mail is not configured or failed: '}Invite link (shown once, valid ${r.expiresInHours} h): ${r.inviteUrl}`)}>Create and invite admin</button></div>
    <Table head={['Company', 'Slug', 'Plan', 'Subscription', 'Status', 'People', '']}>{list.map((c) => (<tr key={c.id}>
      <Td>{c.name}</Td><Td>{c.slug}</Td>
      <Td><select className="input !py-1" value={c.plan} onChange={(e) => run(() => api(`/platform/companies/${c.id}`, 'PATCH', { plan: e.target.value }), () => 'Plan updated')}>{['starter', 'growth', 'professional', 'enterprise'].map((p) => <option key={p}>{p}</option>)}</select></Td>
      <Td><select className="input !py-1" value={c.subState} onChange={(e) => run(() => api(`/platform/companies/${c.id}`, 'PATCH', { subState: e.target.value }), () => 'Subscription state updated')}>{['trial', 'active', 'past_due', 'read_only', 'cancel_pending', 'cancelled'].map((p) => <option key={p}>{p}</option>)}</select></Td>
      <Td><Tag s={c.status === 'active' ? 'active' : 'rejected'} /></Td><Td>{c.employees}</Td>
      <Td><span className="flex flex-wrap gap-2"><button className="btn-ghost !px-2 !py-1" onClick={() => run(() => api(`/platform/companies/${c.id}`, 'PATCH', { status: c.status === 'active' ? 'suspended' : 'active' }), () => c.status === 'active' ? 'Suspended: all sessions ended' : 'Reactivated')}>{c.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button className="btn-ghost !px-2 !py-1" onClick={() => run(() => api(`/platform/companies/${c.id}/reinvite`, 'POST'), (r) => `${r.emailed ? 'The invitation was emailed again. ' : 'E-mail is not configured or failed. '}New invite link (shown once): ${r.inviteUrl}`)}>Re-invite admin</button></span></Td></tr>))}</Table></div>);
}

export function PlatformShell() {
  return (<div className="min-h-screen"><header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3"><Logo className="h-9 w-auto" /><span className="rounded-full bg-navy-900 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">Platform</span>
    <button className="btn-ghost ml-auto" onClick={doLogout}><LogOut size={16} className="mr-1 inline" />Logout</button></header><main className="mx-auto max-w-6xl p-4 sm:p-6"><Platform /></main></div>);
}
