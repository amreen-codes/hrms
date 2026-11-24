import { useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { api } from './api';
import { Title } from './pages';

const usd = (c: number | null) => (c === null ? 'Contact sales' : `$${(c / 100).toLocaleString()} / month`);
const STATE: Record<string, string> = { trial: 'Trial', active: 'Active', past_due: 'Payment failed: please update your card', read_only: 'Read-only until payment succeeds', cancel_pending: 'Cancels at the end of the period', cancelled: 'Cancelled' };
const d = (v: any) => (v ? new Date(v).toLocaleDateString() : '-');

/** Admin-only: plan, subscription state, Stripe Checkout and the Stripe customer portal (plan change, card, cancel, invoices). */
export function Billing() {
  const [b, setB] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState('');
  useEffect(() => { api('/billing').then(setB).catch((e) => setErr(e.message)); }, []);
  const go = async (path: string, body?: any, tag = path) => { setBusy(tag); setErr(''); try { const r = await api(path, 'POST', body); window.location.assign(r.url); } catch (e: any) { setErr(e.message); setBusy(''); } };
  if (!b) return <div className="space-y-4"><Title>Billing</Title>{err ? <p className="text-red-600" role="alert">{err}</p> : <p className="text-slate-500">Loading...</p>}</div>;
  const subscribed = ['active', 'past_due', 'cancel_pending'].includes(b.subState);
  return (<div className="space-y-4"><Title>Billing</Title>
    {new URLSearchParams(location.search).get('billing') === 'success' && <p className="alert-ok" role="status">Thank you. Your payment is being confirmed: this page updates within a minute.</p>}
    <div className="card space-y-2"><div className="flex items-center gap-2 font-semibold"><CreditCard size={18} /> Current plan: <span className="capitalize">{b.plan}</span></div>
      <div className={`text-sm ${['past_due', 'read_only', 'cancelled'].includes(b.subState) ? 'text-red-600' : 'text-slate-600'}`}>{STATE[b.subState] || b.subState}</div>
      <div className="text-sm text-slate-500">Renews / ends: {d(b.periodEndsAt)}{b.subState === 'past_due' && ` | Grace period ends: ${d(b.graceEndsAt)}`}</div>
      {!b.stripeConfigured && <p className="text-sm text-amber-700">Online payment is not set up on this server yet. Contact your platform administrator.</p>}
      {b.hasCustomer && b.stripeConfigured && <button className="btn" disabled={!!busy} onClick={() => go('/billing/portal')}>Manage billing (card, plan, cancel, invoices)</button>}</div>
    {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
    {!subscribed && <div className="grid gap-3 sm:grid-cols-3">{b.plans.map((p: any) => (<div key={p.key} className={`card space-y-2 ${p.key === b.plan ? 'ring-2 ring-indigo-500' : ''}`}><div className="font-semibold">{p.name}</div><div className="text-sm text-slate-600">{usd(p.priceCents)}</div>
      {p.selfServe ? <button className="btn w-full" disabled={!b.stripeConfigured || !!busy} onClick={() => go('/billing/checkout', { plan: p.key }, p.key)}>{busy === p.key ? 'Opening...' : 'Subscribe'}</button> : <p className="text-xs text-slate-500">Enterprise is quoted individually.</p>}</div>))}</div>}
  </div>);
}
