import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import * as C from '../src/lifecycleCore';

const key = () => crypto.randomBytes(32).toString('base64');
const ring = (cur = key(), old = '') => C.loadKeyring({ DATA_ENCRYPTION_KEY: cur, DATA_ENCRYPTION_KEY_OLD: old });

describe('P5 encryption of I-9 / W-4 data', () => {
  it('round-trips and never stores plaintext', () => {
    const k = ring(); const secret = { ssn: '123456789', dob: '1990-01-02' };
    const blob = C.encryptJson(secret, C.formAad('w4', 7), k);
    expect(blob).not.toContain('123456789'); expect(blob.startsWith('v1.')).toBe(true);
    expect(C.decryptJson(blob, C.formAad('w4', 7), k)).toEqual(secret);
  });
  it('uses a fresh IV every time', () => { const k = ring(); expect(C.encryptJson({ a: 1 }, 'x', k)).not.toBe(C.encryptJson({ a: 1 }, 'x', k)); });
  it('is bound to its row: another employee/form cannot decrypt it', () => {
    const k = ring(); const blob = C.encryptJson({ ssn: '123456789' }, C.formAad('w4', 1), k);
    expect(() => C.decryptJson(blob, C.formAad('w4', 2), k)).toThrow(); expect(() => C.decryptJson(blob, C.formAad('i9_s1', 1), k)).toThrow();
  });
  it('detects tampering', () => {
    const k = ring(); const p = C.encryptJson({ a: 'secret' }, 'x', k).split('.'); const ct = Buffer.from(p[4], 'base64url'); ct[0] ^= 1; p[4] = ct.toString('base64url');
    expect(() => C.decryptJson(p.join('.'), 'x', k)).toThrow();
  });
  it('rejects a wrong key and malformed input', () => {
    const blob = C.encryptJson({ a: 1 }, 'x', ring()); expect(() => C.decryptJson(blob, 'x', ring())).toThrow(); expect(() => C.decryptJson('garbage', 'x', ring())).toThrow();
  });
  it('supports key rotation: old key decrypts, new writes use the new key', () => {
    const oldK = key(); const before = C.encryptJson({ n: 1 }, 'x', ring(oldK)); const rotated = ring(key(), oldK);
    expect(C.decryptJson(before, 'x', rotated)).toEqual({ n: 1 }); expect(C.needsRotation(before, rotated)).toBe(true);
    expect(C.needsRotation(C.encryptJson({ n: 1 }, 'x', rotated), rotated)).toBe(false);
  });
  it('refuses a missing or wrong-size key', () => {
    expect(() => C.loadKeyring({})).toThrow(); expect(() => C.loadKeyring({ DATA_ENCRYPTION_KEY: Buffer.from('short').toString('base64') })).toThrow();
  });
});

describe('SSN and form validation', () => {
  it('accepts valid and rejects invalid SSNs', () => {
    expect(C.normalizeSsn('123-45-6789')).toBe('123456789'); expect(C.normalizeSsn('123 45 6789')).toBe('123456789');
    for (const bad of ['000-12-3456', '666-12-3456', '900-12-3456', '123-00-4567', '123-45-0000', '12345678', 'abcdefghi', '']) expect(C.normalizeSsn(bad)).toBeNull();
    expect(C.maskSsn('123456789')).toBe('***-**-6789');
  });
  const i9 = { lastName: 'Khan', firstName: 'Sara', street: '1 Main St', city: 'Austin', state: 'tx', zip: '78701', dob: '1990-05-05', citizenshipStatus: 'citizen', attestation: true, signedName: 'Sara Khan' };
  it('validates I-9 Section 1 and strips unknown fields', () => {
    const r = C.validateI9S1({ ...i9, evil: '<script>' }, '2026-11-17'); expect(r.ok).toBe(true); expect(r.clean.state).toBe('TX'); expect(r.clean.evil).toBeUndefined();
  });
  it('I-9 S1 requires attestation, valid DOB and status-specific numbers', () => {
    expect(C.validateI9S1({ ...i9, attestation: false }, '2026-11-17').ok).toBe(false);
    expect(C.validateI9S1({ ...i9, dob: '2030-01-01' }, '2026-11-17').ok).toBe(false);
    expect(C.validateI9S1({ ...i9, citizenshipStatus: 'lawful_permanent_resident' }, '2026-11-17').ok).toBe(false);
    expect(C.validateI9S1({ ...i9, citizenshipStatus: 'lawful_permanent_resident', alienNumber: 'A123456789' }, '2026-11-17').ok).toBe(true);
    expect(C.validateI9S1({ ...i9, citizenshipStatus: 'authorized_alien', workAuthExpiry: '2027-01-01' }, '2026-11-17').ok).toBe(false);
    expect(C.validateI9S1({ ...i9, citizenshipStatus: 'bogus' }, '2026-11-17').ok).toBe(false);
  });
  it('W-4 requires a valid SSN and attestation', () => {
    const w4 = { firstName: 'S', lastName: 'K', ssn: '123-45-6789', street: '1 Main', city: 'Austin', state: 'TX', zip: '78701', filingStatus: 'single', attestation: true, signedName: 'S K' };
    const r = C.validateW4(w4, '2026-11-17'); expect(r.ok).toBe(true); expect(r.clean.ssn).toBe('123456789'); expect(r.clean.taxYear).toBe(2026);
    expect(C.validateW4({ ...w4, ssn: '' }, '2026-11-17').ok).toBe(false); expect(C.validateW4({ ...w4, extraWithholding: -5 }, '2026-11-17').ok).toBe(false);
  });
  it('I-9 S2 enforces document lists and flags a late completion (3 business days)', () => {
    const doc = (listType: string) => ({ listType, title: 'Doc', issuingAuthority: 'Gov', documentNumber: '123' });
    const base = { documentChoice: 'list_a', documents: [doc('A')], firstDayOfEmployment: '2026-11-16', examinedOn: '2026-11-17', employerRepName: 'Hana HR', attestation: true };
    const ok = C.validateI9S2(base, '2026-11-17'); expect(ok.ok).toBe(true); expect(ok.late).toBe(false); expect(ok.deadline).toBe('2026-11-19');
    expect(C.validateI9S2(base, '2026-11-20').late).toBe(true);
    expect(C.validateI9S2({ ...base, documents: [doc('B')] }, '2026-11-17').ok).toBe(false);
    expect(C.validateI9S2({ ...base, documentChoice: 'list_b_and_c', documents: [doc('B'), doc('C')] }, '2026-11-17').ok).toBe(true);
    expect(C.validateI9S2({ ...base, documentChoice: 'list_b_and_c', documents: [doc('B'), doc('B')] }, '2026-11-17').ok).toBe(false);
  });
});

describe('dates', () => {
  it('business days skip weekends', () => { expect(C.addBusinessDays('2026-11-13', 3)).toBe('2026-11-18'); expect(C.addBusinessDays('2026-11-16', 0)).toBe('2026-11-16'); expect(C.addBusinessDays('2026-11-19', 3)).toBe('2026-11-24'); });
  it('isoDate rejects impossible dates', () => { expect(C.isoDate('2026-02-30')).toBeNull(); expect(C.isoDate('2026-2-3')).toBeNull(); expect(C.isoDate('2026-02-28')).toBe('2026-02-28'); });
  it('retention default: later of I-9 and payroll rules', () => {
    expect(C.defaultRetentionUntil('2020-01-10', '2026-11-17')).toBe('2030-11-17'); expect(C.defaultRetentionUntil('2026-11-17', '2026-11-18')).toBe('2030-11-18'); expect(C.addYears('2024-02-29', 1)).toBe('2025-02-28');
  });
});

describe('P7 credential expiry reminders at 90, 60, 30 and 7 days', () => {
  it('daysUntil', () => { expect(C.daysUntil('2026-12-17', '2026-11-17')).toBe(30); expect(C.daysUntil('2026-11-17', '2026-11-17')).toBe(0); expect(C.daysUntil('2026-11-10', '2026-11-17')).toBe(-7); });
  it('fires exactly at each threshold, once', () => {
    expect(C.REMINDER_DAYS).toEqual([90, 60, 30, 7]);
    expect(C.reminderThreshold(91, null)).toBeNull();
    let last: number | null = null; const sent: number[] = [];
    for (let left = 120; left >= 1; left--) { const t = C.reminderThreshold(left, last); if (t !== null) { sent.push(t); last = t; } }
    expect(sent).toEqual([90, 60, 30, 7]);
  });
  it('sends each reminder on the right day', () => {
    expect(C.reminderThreshold(90, null)).toBe(90); expect(C.reminderThreshold(60, 90)).toBe(60); expect(C.reminderThreshold(30, 60)).toBe(30); expect(C.reminderThreshold(7, 30)).toBe(7);
    expect(C.reminderThreshold(89, 90)).toBeNull(); expect(C.reminderThreshold(7, 7)).toBeNull(); expect(C.reminderThreshold(6, 7)).toBeNull();
  });
  it('catches up with only the most urgent reminder after downtime, never repeats', () => {
    expect(C.reminderThreshold(5, 90)).toBe(7); expect(C.reminderThreshold(5, 7)).toBeNull(); expect(C.reminderThreshold(45, null)).toBe(60);
  });
  it('expired credentials are not reminded; buckets', () => {
    expect(C.reminderThreshold(0, 7)).toBeNull(); expect(C.reminderThreshold(-3, null)).toBeNull();
    expect(C.credentialBucket(0)).toBe('expired'); expect(C.credentialBucket(-1)).toBe('expired'); expect(C.credentialBucket(1)).toBe('expiring_soon'); expect(C.credentialBucket(90)).toBe('expiring_soon'); expect(C.credentialBucket(91)).toBe('compliant');
  });
});

describe('P5/P8 checklist templates', () => {
  it('onboarding checklist has unique keys, correct owners and due dates', () => {
    const t = C.buildChecklist('onboarding', '2026-11-16'); expect(new Set(t.map((x) => x.key)).size).toBe(t.length);
    expect(t.find((x) => x.key === 'i9_s1')!.dueDate).toBe('2026-11-16'); expect(t.find((x) => x.key === 'i9_s2')!.dueDate).toBe('2026-11-19');
    expect(t.filter((x) => x.mandatory).length).toBeGreaterThan(5); expect(t.find((x) => x.key === 'mgr_ack')!.mandatory).toBe(false);
  });
  it('offboarding checklist covers assets, access, final pay, benefits, retention', () => {
    const k = C.buildChecklist('offboarding', '2026-12-01').map((x) => x.key);
    for (const must of ['handover', 'collect_assets', 'revoke_access', 'final_pay', 'benefits_notice', 'retention']) expect(k).toContain(must);
  });
});
