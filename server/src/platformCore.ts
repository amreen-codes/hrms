/** P11/P12 billing + gating and P14 idle timeout. Pure: no DB, no clock (callers pass times). */
import crypto from 'node:crypto';
export type PlanKey = 'starter' | 'growth' | 'professional' | 'enterprise';
export const PLANS: Record<PlanKey, { name: string; priceCents: number | null }> = {
  starter: { name: 'Starter', priceCents: 7900 }, growth: { name: 'Growth', priceCents: 14900 }, professional: { name: 'Professional', priceCents: 29900 }, enterprise: { name: 'Enterprise', priceCents: null } };
const RANK: PlanKey[] = ['starter', 'growth', 'professional', 'enterprise'];
/** Lowest plan that includes a feature. Credentials on Growth and above is from P12; the rest are product defaults to review. */
export const FEATURE_MIN: Record<string, PlanKey> = { core: 'starter', credentials: 'growth', recruitment: 'growth', compensation: 'professional', training: 'professional', performance: 'professional', reports: 'growth', insurance: 'professional' };
export const hasFeature = (plan: PlanKey, f: string) => RANK.indexOf(plan) >= RANK.indexOf(FEATURE_MIN[f] ?? 'enterprise');
/** Charge (positive) or credit (negative) in cents for switching plans part-way through a period. */
export const prorate = (oldCents: number, newCents: number, daysLeft: number, daysInPeriod: number) => daysInPeriod <= 0 ? 0 : Math.round((newCents - oldCents) * Math.max(0, Math.min(daysLeft, daysInPeriod)) / daysInPeriod);

export type SubState = 'trial' | 'active' | 'past_due' | 'read_only' | 'cancel_pending' | 'cancelled';
export type SubEvent = 'payment_succeeded' | 'payment_failed' | 'grace_expired' | 'cancel_requested' | 'cancel_undone' | 'period_ended' | 'trial_expired';
const T: Record<SubState, Partial<Record<SubEvent, SubState>>> = {
  trial: { payment_succeeded: 'active', trial_expired: 'read_only', cancel_requested: 'cancelled' },
  active: { payment_failed: 'past_due', cancel_requested: 'cancel_pending' },
  past_due: { payment_succeeded: 'active', grace_expired: 'read_only', cancel_requested: 'cancel_pending' },
  read_only: { payment_succeeded: 'active', cancel_requested: 'cancelled' },
  cancel_pending: { cancel_undone: 'active', period_ended: 'cancelled' },
  cancelled: {} };
export const nextState = (s: SubState, e: SubEvent): SubState => T[s][e] ?? s;   // unknown event: stay put
export const graceEndsAt = (failedAtMs: number, graceDays = 7) => failedAtMs + graceDays * 864e5;
/** full: normal. read_only: GET only. blocked: nothing (cancelled). */
export const accessMode = (s: SubState): 'full' | 'read_only' | 'blocked' => (s === 'read_only' ? 'read_only' : s === 'cancelled' ? 'blocked' : 'full');
export function gate(a: { state: SubState; plan: PlanKey; feature: string; method: string }): { ok: true } | { ok: false; status: number; error: string } {
  const m = accessMode(a.state);
  if (m === 'blocked') return { ok: false, status: 402, error: 'Subscription cancelled' };
  if (m === 'read_only' && !['GET', 'HEAD', 'OPTIONS'].includes(a.method.toUpperCase())) return { ok: false, status: 402, error: 'Payment failed: the company is in read-only mode' };
  if (!hasFeature(a.plan, a.feature)) return { ok: false, status: 403, error: `${a.feature} is not included in the ${PLANS[a.plan].name} plan` };
  return { ok: true };
}
/** Stripe webhook signature: header "t=...,v1=..."; signed payload is `${t}.${rawBody}`, HMAC-SHA256 hex, 5 minute tolerance. */
export function verifyStripeSignature(raw: string, header: string, secret: string, nowSec: number, tolerance = 300): boolean {
  const p = Object.fromEntries(String(header || '').split(',').map((x) => x.split('=') as [string, string])); const t = Number(p.t);
  if (!secret || !Number.isFinite(t) || Math.abs(nowSec - t) > tolerance || !p.v1) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')), got = Buffer.from(p.v1);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---------- sessions ----------
export const isIdle = (lastActivityMs: number, nowMs: number, minutes = 15) => nowMs - lastActivityMs > minutes * 60_000;
