import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import * as P from '../src/platformCore';
describe('sessions (P14)', () => {
  it('idle after 15 minutes', () => { expect(P.isIdle(0, 15 * 60_000)).toBe(false); expect(P.isIdle(0, 15 * 60_000 + 1)).toBe(true); });
  it('MFA helpers are gone from the module', () => { for (const k of ['totp', 'verifyTotp', 'newSecret', 'otpauthUri', 'recoveryCodes', 'hashCode', 'mfaRequired', 'b32encode', 'b32decode']) expect((P as any)[k]).toBeUndefined(); });
});
describe('billing (P11/P12)', () => {
  it('prices', () => { expect(P.PLANS.starter.priceCents).toBe(7900); expect(P.PLANS.enterprise.priceCents).toBeNull(); });
  it('credentials needs Growth', () => { expect(P.hasFeature('starter', 'credentials')).toBe(false); expect(P.hasFeature('growth', 'credentials')).toBe(true); expect(P.hasFeature('starter', 'unknown-feature')).toBe(false); });
  it('proration charge and credit', () => { expect(P.prorate(7900, 14900, 15, 30)).toBe(3500); expect(P.prorate(14900, 7900, 15, 30)).toBe(-3500); expect(P.prorate(1, 2, 99, 30)).toBe(1); });
  it('failed payment: past due, grace expires, read-only, paying restores', () => { let s = P.nextState('active', 'payment_failed'); expect(s).toBe('past_due'); s = P.nextState(s, 'grace_expired'); expect(s).toBe('read_only'); expect(P.nextState(s, 'payment_succeeded')).toBe('active'); });
  it('cancel keeps access until period end', () => { const s = P.nextState('active', 'cancel_requested'); expect(s).toBe('cancel_pending'); expect(P.accessMode(s)).toBe('full'); expect(P.accessMode(P.nextState(s, 'period_ended'))).toBe('blocked'); });
  it('unknown events do not change state', () => expect(P.nextState('cancelled', 'payment_succeeded')).toBe('cancelled'));
  it('gate: read-only blocks writes, plan blocks features', () => {
    expect((P.gate({ state: 'read_only', plan: 'growth', feature: 'core', method: 'POST' }) as any).status).toBe(402);
    expect(P.gate({ state: 'read_only', plan: 'growth', feature: 'core', method: 'GET' }).ok).toBe(true);
    expect((P.gate({ state: 'active', plan: 'starter', feature: 'credentials', method: 'GET' }) as any).status).toBe(403);
    expect(P.gate({ state: 'trial', plan: 'professional', feature: 'compensation', method: 'POST' }).ok).toBe(true);
  });
  it('Stripe-style webhook signature', () => {
    const body = '{"type":"invoice.payment_failed"}', t = 1_700_000_000, v1 = crypto.createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex');
    expect(P.verifyStripeSignature(body, `t=${t},v1=${v1}`, 'whsec', t + 10)).toBe(true);
    expect(P.verifyStripeSignature(body + ' ', `t=${t},v1=${v1}`, 'whsec', t + 10)).toBe(false);
    expect(P.verifyStripeSignature(body, `t=${t},v1=${v1}`, 'whsec', t + 301)).toBe(false);
    expect(P.verifyStripeSignature(body, `t=${t},v1=${v1}`, '', t)).toBe(false);
  });
});
