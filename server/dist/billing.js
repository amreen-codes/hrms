"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeWebhook = exports.billingRouter = exports.planFromAmount = exports.stripeConfigured = void 0;
exports.formEncode = formEncode;
exports.stripe = stripe;
exports.applyStripeEvent = applyStripeEvent;
exports.expireGracePeriods = expireGracePeriods;
/** P11/P12 Stripe billing: Checkout for a plan, Customer Portal (change plan / cancel / card), and a signed, idempotent webhook that drives the subscription state machine. No Stripe SDK: plain HTTPS calls. */
const express_1 = require("express");
const express_2 = __importDefault(require("express"));
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
const http_1 = require("./http");
const platformCore_1 = require("./platformCore");
const mail_1 = require("./mail");
const services_1 = require("./services");
const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;
exports.stripeConfigured = stripeConfigured;
const API = () => process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';
const SELF_SERVE = ['starter', 'growth', 'professional']; // enterprise has no list price: sales-led
/** Stripe wants application/x-www-form-urlencoded with bracket notation for nesting. */
function formEncode(o, prefix = '') {
    const out = [];
    for (const [k, v] of Object.entries(o)) {
        if (v === undefined || v === null)
            continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (typeof v === 'object')
            out.push(...formEncode(v, key));
        else
            out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
    return out;
}
async function stripe(path, params = {}, method = 'POST') {
    if (!(0, exports.stripeConfigured)())
        throw (0, http_1.bad)('Stripe is not configured on the server (STRIPE_SECRET_KEY)', 503);
    const body = formEncode(params).join('&');
    const res = await fetch(API() + path + (method === 'GET' && body ? '?' + body : ''), { method, headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? body : undefined, signal: AbortSignal.timeout(20_000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
        console.error('Stripe error', res.status, d?.error?.type, d?.error?.code);
        throw (0, http_1.bad)('The payment provider refused the request. Try again or contact support.', 502);
    }
    return d;
}
/** Which plan does a recurring monthly amount (cents) belong to? Used when a customer changes plan in the portal. */
const planFromAmount = (cents) => (SELF_SERVE.find((p) => platformCore_1.PLANS[p].priceCents === cents) ?? null);
exports.planFromAmount = planFromAmount;
exports.billingRouter = (0, express_1.Router)();
const admin = (0, http_1.only)('admin');
exports.billingRouter.get('/billing', admin, (0, http_1.wrap)(async (q, s) => {
    const c = await M.Company.findByPk(q.user.companyId);
    s.json({ plan: c.plan, subState: c.subState, periodEndsAt: c.periodEndsAt, graceEndsAt: c.graceEndsAt, stripeConfigured: (0, exports.stripeConfigured)(), hasCustomer: !!c.stripeCustomerId,
        plans: Object.keys(platformCore_1.PLANS).map((k) => ({ key: k, name: platformCore_1.PLANS[k].name, priceCents: platformCore_1.PLANS[k].priceCents, selfServe: SELF_SERVE.includes(k) })) });
}));
exports.billingRouter.post('/billing/checkout', admin, (0, http_1.wrap)(async (q, s) => {
    const plan = String(q.body?.plan || '');
    if (!SELF_SERVE.includes(plan))
        throw (0, http_1.bad)(plan === 'enterprise' ? 'Enterprise is quoted individually: contact sales' : 'Unknown plan');
    const c = await M.Company.findByPk(q.user.companyId);
    if (c.stripeSubscriptionId && ['active', 'past_due', 'cancel_pending'].includes(c.subState))
        throw (0, http_1.bad)('You already have a subscription. Use "Manage billing" to change plan or card.', 409);
    let customer = c.stripeCustomerId;
    if (!customer) {
        const me = await M.Employee.findByPk(q.user.id, { attributes: ['email', 'name'] });
        customer = (await stripe('/customers', { name: c.name, email: me?.email, metadata: { companyId: c.id } })).id;
        await c.update({ stripeCustomerId: customer });
    }
    const meta = { companyId: c.id, plan };
    const sess = await stripe('/checkout/sessions', { mode: 'subscription', customer, client_reference_id: c.id, metadata: meta, subscription_data: { metadata: meta },
        line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: platformCore_1.PLANS[plan].priceCents, recurring: { interval: 'month' }, product_data: { name: `AMS HRMS ${platformCore_1.PLANS[plan].name}` } } } },
        success_url: `${(0, mail_1.appBase)()}/?billing=success`, cancel_url: `${(0, mail_1.appBase)()}/?billing=cancelled` });
    await (0, services_1.log)(q.user.id, 'Billing Checkout Started', plan);
    s.json({ url: sess.url });
}));
exports.billingRouter.post('/billing/portal', admin, (0, http_1.wrap)(async (q, s) => {
    const c = await M.Company.findByPk(q.user.companyId);
    if (!c.stripeCustomerId)
        throw (0, http_1.bad)('No billing account yet: choose a plan first', 409);
    const p = await stripe('/billing_portal/sessions', { customer: c.stripeCustomerId, return_url: `${(0, mail_1.appBase)()}/` });
    await (0, services_1.log)(q.user.id, 'Billing Portal Opened', '');
    s.json({ url: p.url });
}));
// ---------------------------------------------------------------- webhook (public, signature-verified, idempotent)
const byCustomer = (id) => M.Company.findOne({ where: { stripeCustomerId: id } });
const fromMeta = async (meta, customer) => {
    const c = (meta?.companyId && (await M.Company.findByPk(Number(meta.companyId)))) || (customer ? await byCustomer(customer) : null);
    if (c && c.stripeCustomerId && customer && c.stripeCustomerId !== customer)
        return null; // metadata must agree with the customer we created for that company
    return c;
};
/** Applies one Stripe event. Returns a short outcome string for the event log. */
async function applyStripeEvent(ev) {
    const o = ev?.data?.object || {}, now = Date.now(), type = String(ev?.type || '');
    if (type === 'checkout.session.completed') {
        const c = await fromMeta(o.metadata, o.customer);
        if (!c)
            return 'ignored: unknown company';
        const plan = SELF_SERVE.includes(o.metadata?.plan) ? o.metadata.plan : c.plan;
        await c.update({ plan, stripeCustomerId: o.customer || c.stripeCustomerId, stripeSubscriptionId: o.subscription || c.stripeSubscriptionId, subState: c.subState === 'cancelled' ? 'active' : (0, platformCore_1.nextState)(c.subState, 'payment_succeeded'), failedAt: null, graceEndsAt: null }); // a cancelled company that subscribes again is reactivated
        return `checkout completed: ${c.slug} -> ${plan}`;
    }
    if (type === 'invoice.payment_succeeded' || type === 'invoice.paid') {
        const c = o.customer && (await byCustomer(o.customer));
        if (!c)
            return 'ignored: unknown customer';
        const end = o.lines?.data?.[0]?.period?.end;
        await c.update({ subState: (0, platformCore_1.nextState)(c.subState, 'payment_succeeded'), failedAt: null, graceEndsAt: null, ...(end ? { periodEndsAt: new Date(end * 1000) } : {}) });
        return `payment ok: ${c.slug}`;
    }
    if (type === 'invoice.payment_failed') {
        const c = o.customer && (await byCustomer(o.customer));
        if (!c)
            return 'ignored: unknown customer';
        const st = (0, platformCore_1.nextState)(c.subState, 'payment_failed');
        await c.update({ subState: st, failedAt: c.failedAt || new Date(now), graceEndsAt: c.graceEndsAt || new Date((0, platformCore_1.graceEndsAt)(now)) }); // 7 days to fix the card, then read-only (job)
        return `payment failed: ${c.slug} -> ${st}`;
    }
    if (type === 'customer.subscription.updated') {
        const c = o.customer && (await byCustomer(o.customer));
        if (!c)
            return 'ignored: unknown customer';
        const up = { stripeSubscriptionId: o.id || c.stripeSubscriptionId };
        const plan = (0, exports.planFromAmount)(Number(o.items?.data?.[0]?.price?.unit_amount));
        if (plan)
            up.plan = plan; // plan changed in the portal (proration is handled by Stripe)
        if (o.cancel_at_period_end === true)
            up.subState = (0, platformCore_1.nextState)(c.subState, 'cancel_requested');
        else if (o.cancel_at_period_end === false)
            up.subState = (0, platformCore_1.nextState)(c.subState, 'cancel_undone');
        if (o.current_period_end)
            up.periodEndsAt = new Date(o.current_period_end * 1000);
        await c.update(up);
        return `subscription updated: ${c.slug}`;
    }
    if (type === 'customer.subscription.deleted') {
        const c = o.customer && (await byCustomer(o.customer));
        if (!c)
            return 'ignored: unknown customer';
        await c.update({ subState: 'cancelled', stripeSubscriptionId: null }); // Stripe ends the subscription for good (period over, or cancelled at once): access stops return `subscription ended: ${c.slug}`;
    }
    return 'ignored: event type';
}
/** Mounted in app.ts BEFORE express.json(): the signature is computed over the raw bytes. */
exports.stripeWebhook = [express_2.default.raw({ type: 'application/json', limit: '1mb' }), (q, s) => {
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret)
            return s.status(503).json({ error: 'Webhook is not configured' });
        const raw = Buffer.isBuffer(q.body) ? q.body.toString('utf8') : '';
        if (!raw || !(0, platformCore_1.verifyStripeSignature)(raw, String(q.headers['stripe-signature'] || ''), secret, Math.floor(Date.now() / 1000)))
            return s.status(400).json({ error: 'Invalid signature' });
        let ev;
        try {
            ev = JSON.parse(raw);
        }
        catch {
            return s.status(400).json({ error: 'Invalid payload' });
        }
        if (!ev?.id || !ev?.type)
            return s.status(400).json({ error: 'Invalid event' });
        (0, tenancy_1.runSystem)(async () => {
            try {
                await M.StripeEvent.create({ eventId: String(ev.id).slice(0, 80), type: String(ev.type).slice(0, 80) });
            }
            catch {
                return s.json({ received: true, duplicate: true });
            } // already handled (unique id)
            try {
                const outcome = await applyStripeEvent(ev);
                await M.StripeEvent.update({ outcome: outcome.slice(0, 200) }, { where: { eventId: String(ev.id) } });
                s.json({ received: true });
            }
            catch (e) {
                await M.StripeEvent.destroy({ where: { eventId: String(ev.id) } }).catch(() => null);
                console.error('stripe webhook failed:', e?.message);
                s.status(500).json({ error: 'Processing failed' });
            } // Stripe will retry
        }).catch(() => s.status(500).json({ error: 'Processing failed' }));
    }];
/** Daily job: a company whose 7 day grace period for a failed payment has passed becomes read-only. */
async function expireGracePeriods() {
    const rows = await (0, tenancy_1.runSystem)(() => M.Company.findAll({ where: { subState: 'past_due' } }));
    let n = 0;
    for (const c of rows)
        if (c.graceEndsAt && +new Date(c.graceEndsAt) < Date.now()) {
            await (0, tenancy_1.runSystem)(() => c.update({ subState: (0, platformCore_1.nextState)('past_due', 'grace_expired') }));
            n++;
        }
    return n;
}
