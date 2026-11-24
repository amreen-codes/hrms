/** P11/P12 Stripe billing: Checkout for a plan, Customer Portal (change plan / cancel / card), and a signed, idempotent webhook that drives the subscription state machine. No Stripe SDK: plain HTTPS calls. */
import { Router } from 'express';
import express from 'express';
import * as M from './models';
import { runSystem } from './tenancy';
import { wrap, bad, only } from './http';
import { PLANS, PlanKey, SubState, nextState, graceEndsAt, verifyStripeSignature } from './platformCore';
import { appBase } from './mail';
import { log } from './services';

export const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;
const API = () => process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';
const SELF_SERVE: PlanKey[] = ['starter', 'growth', 'professional'];       // enterprise has no list price: sales-led

/** Stripe wants application/x-www-form-urlencoded with bracket notation for nesting. */
export function formEncode(o: any, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') out.push(...formEncode(v, key)); else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}
export async function stripe(path: string, params: any = {}, method: 'POST' | 'GET' = 'POST'): Promise<any> {
  if (!stripeConfigured()) throw bad('Stripe is not configured on the server (STRIPE_SECRET_KEY)', 503);
  const body = formEncode(params).join('&');
  const res = await fetch(API() + path + (method === 'GET' && body ? '?' + body : ''), { method, headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? body : undefined, signal: AbortSignal.timeout(20_000) });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Stripe error', res.status, d?.error?.type, d?.error?.code); throw bad('The payment provider refused the request. Try again or contact support.', 502); }
  return d;
}
/** Which plan does a recurring monthly amount (cents) belong to? Used when a customer changes plan in the portal. */
export const planFromAmount = (cents: number): PlanKey | null => (SELF_SERVE.find((p) => PLANS[p].priceCents === cents) ?? null);

export const billingRouter = Router();
const admin = only('admin');
billingRouter.get('/billing', admin, wrap(async (q, s) => {
  const c: any = await M.Company.findByPk(q.user.companyId);
  s.json({ plan: c.plan, subState: c.subState, periodEndsAt: c.periodEndsAt, graceEndsAt: c.graceEndsAt, stripeConfigured: stripeConfigured(), hasCustomer: !!c.stripeCustomerId,
    plans: (Object.keys(PLANS) as PlanKey[]).map((k) => ({ key: k, name: PLANS[k].name, priceCents: PLANS[k].priceCents, selfServe: SELF_SERVE.includes(k) })) });
}));
billingRouter.post('/billing/checkout', admin, wrap(async (q, s) => {
  const plan = String(q.body?.plan || '') as PlanKey;
  if (!SELF_SERVE.includes(plan)) throw bad(plan === 'enterprise' ? 'Enterprise is quoted individually: contact sales' : 'Unknown plan');
  const c: any = await M.Company.findByPk(q.user.companyId);
  if (c.stripeSubscriptionId && ['active', 'past_due', 'cancel_pending'].includes(c.subState)) throw bad('You already have a subscription. Use "Manage billing" to change plan or card.', 409);
  let customer = c.stripeCustomerId;
  if (!customer) {
    const me: any = await M.Employee.findByPk(q.user.id, { attributes: ['email', 'name'] });
    customer = (await stripe('/customers', { name: c.name, email: me?.email, metadata: { companyId: c.id } })).id;
    await c.update({ stripeCustomerId: customer });
  }
  const meta = { companyId: c.id, plan };
  const sess = await stripe('/checkout/sessions', { mode: 'subscription', customer, client_reference_id: c.id, metadata: meta, subscription_data: { metadata: meta },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: PLANS[plan].priceCents, recurring: { interval: 'month' }, product_data: { name: `AMS HRMS ${PLANS[plan].name}` } } } },
    success_url: `${appBase()}/?billing=success`, cancel_url: `${appBase()}/?billing=cancelled` });
  await log(q.user.id, 'Billing Checkout Started', plan); s.json({ url: sess.url });
}));
billingRouter.post('/billing/portal', admin, wrap(async (q, s) => {
  const c: any = await M.Company.findByPk(q.user.companyId);
  if (!c.stripeCustomerId) throw bad('No billing account yet: choose a plan first', 409);
  const p = await stripe('/billing_portal/sessions', { customer: c.stripeCustomerId, return_url: `${appBase()}/` });
  await log(q.user.id, 'Billing Portal Opened', ''); s.json({ url: p.url });
}));

// ---------------------------------------------------------------- webhook (public, signature-verified, idempotent)
const byCustomer = (id: string) => M.Company.findOne({ where: { stripeCustomerId: id } }) as Promise<any>;
const fromMeta = async (meta: any, customer?: string) => {
  const c: any = (meta?.companyId && (await M.Company.findByPk(Number(meta.companyId)))) || (customer ? await byCustomer(customer) : null);
  if (c && c.stripeCustomerId && customer && c.stripeCustomerId !== customer) return null;   // metadata must agree with the customer we created for that company
  return c;
};
/** Applies one Stripe event. Returns a short outcome string for the event log. */
export async function applyStripeEvent(ev: any): Promise<string> {
  const o = ev?.data?.object || {}, now = Date.now(), type = String(ev?.type || '');
  if (type === 'checkout.session.completed') {
    const c = await fromMeta(o.metadata, o.customer); if (!c) return 'ignored: unknown company';
    const plan = SELF_SERVE.includes(o.metadata?.plan) ? o.metadata.plan : c.plan;
    await c.update({ plan, stripeCustomerId: o.customer || c.stripeCustomerId, stripeSubscriptionId: o.subscription || c.stripeSubscriptionId, subState: c.subState === 'cancelled' ? 'active' : nextState(c.subState as SubState, 'payment_succeeded'), failedAt: null, graceEndsAt: null });   // a cancelled company that subscribes again is reactivated
    return `checkout completed: ${c.slug} -> ${plan}`;
  }
  if (type === 'invoice.payment_succeeded' || type === 'invoice.paid') {
    const c = o.customer && (await byCustomer(o.customer)); if (!c) return 'ignored: unknown customer';
    const end = o.lines?.data?.[0]?.period?.end;
    await c.update({ subState: nextState(c.subState as SubState, 'payment_succeeded'), failedAt: null, graceEndsAt: null, ...(end ? { periodEndsAt: new Date(end * 1000) } : {}) });
    return `payment ok: ${c.slug}`;
  }
  if (type === 'invoice.payment_failed') {
    const c = o.customer && (await byCustomer(o.customer)); if (!c) return 'ignored: unknown customer';
    const st = nextState(c.subState as SubState, 'payment_failed');
    await c.update({ subState: st, failedAt: c.failedAt || new Date(now), graceEndsAt: c.graceEndsAt || new Date(graceEndsAt(now)) });   // 7 days to fix the card, then read-only (job)
    return `payment failed: ${c.slug} -> ${st}`;
  }
  if (type === 'customer.subscription.updated') {
    const c = o.customer && (await byCustomer(o.customer)); if (!c) return 'ignored: unknown customer';
    const up: any = { stripeSubscriptionId: o.id || c.stripeSubscriptionId };
    const plan = planFromAmount(Number(o.items?.data?.[0]?.price?.unit_amount)); if (plan) up.plan = plan;       // plan changed in the portal (proration is handled by Stripe)
    if (o.cancel_at_period_end === true) up.subState = nextState(c.subState as SubState, 'cancel_requested');
    else if (o.cancel_at_period_end === false) up.subState = nextState(c.subState as SubState, 'cancel_undone');
    if (o.current_period_end) up.periodEndsAt = new Date(o.current_period_end * 1000);
    await c.update(up); return `subscription updated: ${c.slug}`;
  }
  if (type === 'customer.subscription.deleted') {
    const c = o.customer && (await byCustomer(o.customer)); if (!c) return 'ignored: unknown customer';
    await c.update({ subState: 'cancelled', stripeSubscriptionId: null });   // Stripe ends the subscription for good (period over, or cancelled at once): access stops return `subscription ended: ${c.slug}`;
  }
  return 'ignored: event type';
}
/** Mounted in app.ts BEFORE express.json(): the signature is computed over the raw bytes. */
export const stripeWebhook = [express.raw({ type: 'application/json', limit: '1mb' }), (q: any, s: any) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret) return s.status(503).json({ error: 'Webhook is not configured' });
  const raw = Buffer.isBuffer(q.body) ? q.body.toString('utf8') : '';
  if (!raw || !verifyStripeSignature(raw, String(q.headers['stripe-signature'] || ''), secret, Math.floor(Date.now() / 1000))) return s.status(400).json({ error: 'Invalid signature' });
  let ev: any; try { ev = JSON.parse(raw); } catch { return s.status(400).json({ error: 'Invalid payload' }); }
  if (!ev?.id || !ev?.type) return s.status(400).json({ error: 'Invalid event' });
  runSystem(async () => {
    try { await M.StripeEvent.create({ eventId: String(ev.id).slice(0, 80), type: String(ev.type).slice(0, 80) } as any); } catch { return s.json({ received: true, duplicate: true }); }   // already handled (unique id)
    try { const outcome = await applyStripeEvent(ev); await M.StripeEvent.update({ outcome: outcome.slice(0, 200) }, { where: { eventId: String(ev.id) } }); s.json({ received: true }); }
    catch (e: any) { await M.StripeEvent.destroy({ where: { eventId: String(ev.id) } }).catch(() => null); console.error('stripe webhook failed:', e?.message); s.status(500).json({ error: 'Processing failed' }); }   // Stripe will retry
  }).catch(() => s.status(500).json({ error: 'Processing failed' }));
}];
/** Daily job: a company whose 7 day grace period for a failed payment has passed becomes read-only. */
export async function expireGracePeriods() {
  const rows: any[] = await runSystem(() => M.Company.findAll({ where: { subState: 'past_due' } }));
  let n = 0; for (const c of rows) if (c.graceEndsAt && +new Date(c.graceEndsAt) < Date.now()) { await runSystem(() => c.update({ subState: nextState('past_due', 'grace_expired') })); n++; }
  return n;
}
