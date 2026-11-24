import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as M from '../src/models';
import { buildApp } from '../src/app';
import { formEncode, planFromAmount, expireGracePeriods, applyStripeEvent } from '../src/billing';
import { runSystem } from '../src/tenancy';

const app = buildApp(); const PW = 'Correct-Horse-Battery-9', SECRET = 'whsec_test_secret';
const mk = (name: string, role: string) => M.Employee.create({ name, email: `${name.toLowerCase()}@t.test`, role, password: bcrypt.hashSync(PW, 4), status: 'active' } as any) as any;
const tok = async (n: string) => (await request(app).post('/api/auth/login').send({ email: `${n.toLowerCase()}@t.test`, password: PW })).body.token as string;
const bearer = (t: string) => ({ Authorization: 'Bearer ' + t });
const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const hook = (ev: any, header?: string) => { const body = JSON.stringify(ev); return request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', header ?? sign(body)).send(body); };
const co = () => runSystem(() => M.Company.findByPk(1)) as Promise<any>;
let n = 0; const ev = (type: string, object: any) => ({ id: `evt_${++n}`, type, data: { object } });
let T: Record<string, string> = {};

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  await M.sequelize.sync({ force: true });
  await mk('Ada', 'admin'); await mk('Hana', 'hr'); await mk('Eli', 'employee');
  for (const x of ['Ada', 'Hana', 'Eli']) T[x] = await tok(x);
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

describe('helpers', () => {
  it('form encoding uses bracket notation and escapes values', () => {
    expect(formEncode({ mode: 'subscription', a: { b: { 0: { c: 'x y&z' } } }, skip: undefined, n: 5 }).join('&')).toBe('mode=subscription&a%5Bb%5D%5B0%5D%5Bc%5D=x%20y%26z&n=5');
  });
  it('plan from a monthly amount', () => { expect(planFromAmount(7900)).toBe('starter'); expect(planFromAmount(1)).toBeNull(); });
});

describe('checkout and portal (Stripe API mocked)', () => {
  it('only an admin can see billing or start checkout; Stripe not configured -> 503', async () => {
    for (const x of ['Hana', 'Eli']) { await request(app).get('/api/billing').set(bearer(T[x])).expect(403); await request(app).post('/api/billing/checkout').set(bearer(T[x])).send({ plan: 'growth' }).expect(403); }
    const b = (await request(app).get('/api/billing').set(bearer(T.Ada)).expect(200)).body; expect(b.stripeConfigured).toBe(false); expect(b.plans.find((p: any) => p.key === 'enterprise').selfServe).toBe(false);
    await request(app).post('/api/billing/checkout').set(bearer(T.Ada)).send({ plan: 'growth' }).expect(503);
  });
  it('creates a customer and a subscription Checkout Session for the chosen plan with the company in metadata; enterprise / unknown plans are refused', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ url, body: String(init.body), auth: init.headers.Authorization }); return { ok: true, status: 200, json: async () => (url.endsWith('/customers') ? { id: 'cus_1' } : { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }) }; }));
    await request(app).post('/api/billing/checkout').set(bearer(T.Ada)).send({ plan: 'enterprise' }).expect(400); await request(app).post('/api/billing/checkout').set(bearer(T.Ada)).send({ plan: 'gold' }).expect(400);
    const r = await request(app).post('/api/billing/checkout').set(bearer(T.Ada)).send({ plan: 'growth' }).expect(200); expect(r.body.url).toBe('https://checkout.stripe.test/cs_1');
    expect(calls.map((c) => c.url)).toEqual(['https://api.stripe.com/v1/customers', 'https://api.stripe.com/v1/checkout/sessions']); expect(calls[0].auth).toBe('Bearer sk_test_x');
    const body = decodeURIComponent(calls[1].body); expect(body).toContain('mode=subscription'); expect(body).toContain('customer=cus_1'); expect(body).toContain('metadata[companyId]=1'); expect(body).toContain('metadata[plan]=growth');
    expect(body).toContain('[unit_amount]=14900'); expect(body).toContain('[recurring][interval]=month'); expect((await co()).stripeCustomerId).toBe('cus_1');
  });
  it('a Stripe failure is a clean 502 with no provider detail; the portal needs a customer', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, json: async () => ({ error: { type: 'card_error', message: 'secret detail' } }) })));
    const r = await request(app).post('/api/billing/portal').set(bearer(T.Ada)).expect(502); expect(JSON.stringify(r.body)).not.toContain('secret detail');
  });
});

describe('webhook: signature, idempotency and the subscription state machine', () => {
  it('refuses a missing / wrong / stale signature and malformed payloads', async () => {
    const e = ev('invoice.paid', { customer: 'cus_1' }), body = JSON.stringify(e);
    await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').send(body).expect(400);
    await hook(e, sign(body, undefined, 'whsec_other')).expect(400);
    await hook(e, sign(body, Math.floor(Date.now() / 1000) - 3600)).expect(400);
    const bad = '{not json'; await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', sign(bad)).send(bad).expect(400);
  });
  it('checkout.session.completed activates the plan; the same event id is processed once', async () => {
    const e = ev('checkout.session.completed', { customer: 'cus_1', subscription: 'sub_1', metadata: { companyId: '1', plan: 'professional' } });
    await hook(e).expect(200); let c = await co(); expect(c.plan).toBe('professional'); expect(c.subState).toBe('active'); expect(c.stripeSubscriptionId).toBe('sub_1');
    await c.update({ plan: 'starter' }); const again = await hook(e).expect(200); expect(again.body.duplicate).toBe(true); expect((await co()).plan).toBe('starter');   // not applied a second time
    await c.update({ plan: 'professional' });
  });
  it('metadata for another customer is ignored (a forged company id cannot move a plan)', async () => {
    await hook(ev('checkout.session.completed', { customer: 'cus_EVIL', subscription: 'sub_x', metadata: { companyId: '1', plan: 'starter' } })).expect(200);
    expect((await co()).plan).toBe('professional');
  });
  it('payment failed -> past_due with a 7 day grace; paid -> active again with the period end', async () => {
    await hook(ev('invoice.payment_failed', { customer: 'cus_1' })).expect(200); let c = await co(); expect(c.subState).toBe('past_due'); expect(+new Date(c.graceEndsAt) - Date.now()).toBeGreaterThan(6.9 * 864e5);
    await hook(ev('invoice.payment_succeeded', { customer: 'cus_1', lines: { data: [{ period: { end: 1900000000 } }] } })).expect(200); c = await co();
    expect(c.subState).toBe('active'); expect(c.graceEndsAt).toBeNull(); expect(+new Date(c.periodEndsAt)).toBe(1900000000 * 1000);
  });
  it('plan change in the portal, cancel at period end, undo, and final deletion', async () => {
    await hook(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', cancel_at_period_end: false, items: { data: [{ price: { unit_amount: 7900 } }] } })).expect(200); expect((await co()).plan).toBe('starter');
    await hook(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', cancel_at_period_end: true, items: { data: [{ price: { unit_amount: 7900 } }] } })).expect(200); expect((await co()).subState).toBe('cancel_pending');
    await hook(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', cancel_at_period_end: false, items: { data: [{ price: { unit_amount: 7900 } }] } })).expect(200); expect((await co()).subState).toBe('active');
    await hook(ev('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1' })).expect(200); const c = await co(); expect(c.subState).toBe('cancelled'); expect(c.stripeSubscriptionId).toBeNull();
    await hook(ev('checkout.session.completed', { customer: 'cus_1', subscription: 'sub_2', metadata: { companyId: '1', plan: 'growth' } })).expect(200); expect((await co()).subState).toBe('active');   // subscribing again reactivates
  });
  it('unknown customers and unknown event types are acknowledged and ignored', async () => {
    await hook(ev('invoice.payment_failed', { customer: 'cus_nobody' })).expect(200); await hook(ev('charge.refunded', {})).expect(200);
    expect((await runSystem(() => M.StripeEvent.findAll({ raw: true })) as any[]).some((r) => /ignored/.test(r.outcome))).toBe(true);
  });
  it('a processing error returns 500 and the event can be retried', async () => {
    const e = ev('invoice.payment_failed', { customer: 'cus_1' }); const spy = vi.spyOn(M.Company, 'findOne').mockRejectedValueOnce(new Error('db down'));
    await hook(e).expect(500); spy.mockRestore(); await hook(e).expect(200); expect((await co()).subState).toBe('past_due');
  });
});

describe('grace period and gating', () => {
  it('after the grace period the company becomes read-only; billing stays reachable so it can pay, other writes are blocked', async () => {
    await (await co()).update({ graceEndsAt: new Date(Date.now() - 1000) }); expect(await expireGracePeriods()).toBe(1); expect((await co()).subState).toBe('read_only');
    await request(app).get('/api/billing').set(bearer(T.Ada)).expect(200);
    await request(app).post('/api/leave').set(bearer(T.Eli)).send({ type: 'Annual', startDate: '2026-12-01', endDate: '2026-12-01', hours: 8 }).expect(402);
    await request(app).get('/api/leave').set(bearer(T.Eli)).expect(200);                     // reading still works
    await hook(ev('invoice.payment_succeeded', { customer: 'cus_1' })).expect(200); expect((await co()).subState).toBe('active');
    expect(await applyStripeEvent({ type: 'x', data: {} })).toMatch(/ignored/);
  });
});
