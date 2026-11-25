"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIdle = exports.accessMode = exports.graceEndsAt = exports.nextState = exports.prorate = exports.hasFeature = exports.FEATURE_MIN = exports.PLANS = void 0;
exports.gate = gate;
exports.verifyStripeSignature = verifyStripeSignature;
/** P11/P12 billing + gating and P14 idle timeout. Pure: no DB, no clock (callers pass times). */
const node_crypto_1 = __importDefault(require("node:crypto"));
exports.PLANS = {
    starter: { name: 'Starter', priceCents: 7900 }, growth: { name: 'Growth', priceCents: 14900 }, professional: { name: 'Professional', priceCents: 29900 }, enterprise: { name: 'Enterprise', priceCents: null }
};
const RANK = ['starter', 'growth', 'professional', 'enterprise'];
/** Lowest plan that includes a feature. Credentials on Growth and above is from P12; the rest are product defaults to review. */
exports.FEATURE_MIN = { core: 'starter', credentials: 'growth', recruitment: 'growth', compensation: 'professional', training: 'professional', performance: 'professional', reports: 'growth', insurance: 'professional' };
const hasFeature = (plan, f) => RANK.indexOf(plan) >= RANK.indexOf(exports.FEATURE_MIN[f] ?? 'enterprise');
exports.hasFeature = hasFeature;
/** Charge (positive) or credit (negative) in cents for switching plans part-way through a period. */
const prorate = (oldCents, newCents, daysLeft, daysInPeriod) => daysInPeriod <= 0 ? 0 : Math.round((newCents - oldCents) * Math.max(0, Math.min(daysLeft, daysInPeriod)) / daysInPeriod);
exports.prorate = prorate;
const T = {
    trial: { payment_succeeded: 'active', trial_expired: 'read_only', cancel_requested: 'cancelled' },
    active: { payment_failed: 'past_due', cancel_requested: 'cancel_pending' },
    past_due: { payment_succeeded: 'active', grace_expired: 'read_only', cancel_requested: 'cancel_pending' },
    read_only: { payment_succeeded: 'active', cancel_requested: 'cancelled' },
    cancel_pending: { cancel_undone: 'active', period_ended: 'cancelled' },
    cancelled: {}
};
const nextState = (s, e) => T[s][e] ?? s; // unknown event: stay put
exports.nextState = nextState;
const graceEndsAt = (failedAtMs, graceDays = 7) => failedAtMs + graceDays * 864e5;
exports.graceEndsAt = graceEndsAt;
/** full: normal. read_only: GET only. blocked: nothing (cancelled). */
const accessMode = (s) => (s === 'read_only' ? 'read_only' : s === 'cancelled' ? 'blocked' : 'full');
exports.accessMode = accessMode;
function gate(a) {
    const m = (0, exports.accessMode)(a.state);
    if (m === 'blocked')
        return { ok: false, status: 402, error: 'Subscription cancelled' };
    if (m === 'read_only' && !['GET', 'HEAD', 'OPTIONS'].includes(a.method.toUpperCase()))
        return { ok: false, status: 402, error: 'Payment failed: the company is in read-only mode' };
    if (!(0, exports.hasFeature)(a.plan, a.feature))
        return { ok: false, status: 403, error: `${a.feature} is not included in the ${exports.PLANS[a.plan].name} plan` };
    return { ok: true };
}
/** Stripe webhook signature: header "t=...,v1=..."; signed payload is `${t}.${rawBody}`, HMAC-SHA256 hex, 5 minute tolerance. */
function verifyStripeSignature(raw, header, secret, nowSec, tolerance = 300) {
    const p = Object.fromEntries(String(header || '').split(',').map((x) => x.split('=')));
    const t = Number(p.t);
    if (!secret || !Number.isFinite(t) || Math.abs(nowSec - t) > tolerance || !p.v1)
        return false;
    const want = Buffer.from(node_crypto_1.default.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')), got = Buffer.from(p.v1);
    return want.length === got.length && node_crypto_1.default.timingSafeEqual(want, got);
}
// ---------- sessions ----------
const isIdle = (lastActivityMs, nowMs, minutes = 15) => nowMs - lastActivityMs > minutes * 60_000;
exports.isIdle = isIdle;
