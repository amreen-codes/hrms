/**
 * Pure logic for the employee lifecycle modules (P5 onboarding, P7 credentials, P8 offboarding).
 * No database or framework imports here: everything is deterministic and unit-tested.
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------- dates
const MS_DAY = 864e5;
export const isoDate = (s: unknown): string | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`); return !isNaN(+d) && d.toISOString().slice(0, 10) === s ? s : null;
};
const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);
const fmt = (n: number) => new Date(n).toISOString().slice(0, 10);
export const todayStr = (now = new Date()) => now.toISOString().slice(0, 10);
export const daysUntil = (target: string, today: string) => Math.round((ms(target) - ms(today)) / MS_DAY);
export const addDays = (d: string, n: number) => fmt(ms(d) + n * MS_DAY);
/** Weekends are skipped. Public holidays are NOT modelled (documented gap). */
export function addBusinessDays(d: string, n: number): string {
  let cur = ms(d), left = n;
  while (left > 0) { cur += MS_DAY; const dow = new Date(cur).getUTCDay(); if (dow !== 0 && dow !== 6) left--; }
  return fmt(cur);
}
export function addYears(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number); const t = new Date(Date.UTC(y + n, m - 1, day));
  if (t.getUTCMonth() !== m - 1) t.setUTCDate(0);                 // Feb 29 -> Feb 28
  return t.toISOString().slice(0, 10);
}
/** Default record retention: later of (hire + 3y, term + 1y) for I-9 and term + 4y for payroll tax records. HR may override; confirm with counsel. */
export const defaultRetentionUntil = (hire: string, term: string) => [addYears(hire, 3), addYears(term, 1), addYears(term, 4)].sort().at(-1)!;

// ---------------------------------------------------------------- P7 credential reminders
export const REMINDER_DAYS = [90, 60, 30, 7] as const;
/**
 * Which reminder (if any) is due now. Sends each threshold at most once: returns the smallest threshold
 * that daysLeft has reached, only when it is lower than the last one already sent. Expiry itself (<= 0) is handled separately.
 */
export function reminderThreshold(daysLeft: number, lastSent: number | null): number | null {
  if (daysLeft <= 0) return null;
  const reached = REMINDER_DAYS.filter((d) => daysLeft <= d); if (!reached.length) return null;
  const t = Math.min(...reached); return lastSent === null || t < lastSent ? t : null;
}
export type Bucket = 'expired' | 'expiring_soon' | 'compliant';
export const credentialBucket = (daysLeft: number): Bucket => (daysLeft <= 0 ? 'expired' : daysLeft <= REMINDER_DAYS[0] ? 'expiring_soon' : 'compliant');

// ---------------------------------------------------------------- encryption (AES-256-GCM, key ring, AAD-bound)
export interface Keyring { currentId: string; keys: Map<string, Buffer> }
const kid = (k: Buffer) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 8);
const parseKey = (b64: string) => { const k = Buffer.from(b64.trim(), 'base64'); if (k.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded'); return k; };
/** DATA_ENCRYPTION_KEY = current key. DATA_ENCRYPTION_KEY_OLD = comma separated previous keys (decrypt only), used during rotation. */
export function loadKeyring(env: Record<string, string | undefined> = process.env): Keyring {
  if (!env.DATA_ENCRYPTION_KEY) throw new Error('DATA_ENCRYPTION_KEY is not set');
  const cur = parseKey(env.DATA_ENCRYPTION_KEY); const keys = new Map([[kid(cur), cur]]);
  for (const o of (env.DATA_ENCRYPTION_KEY_OLD || '').split(',').filter((x) => x.trim())) { const k = parseKey(o); keys.set(kid(k), k); }
  return { currentId: kid(cur), keys };
}
let ring: Keyring | null = null;
export const defaultRing = () => (ring ||= loadKeyring());
export const resetRing = () => { ring = null; };
const b64u = (b: Buffer) => b.toString('base64url');
/** Output: v1.<keyId>.<iv>.<tag>.<ciphertext>. `aad` binds the ciphertext to its row (swapping rows breaks decryption). */
export function encryptJson(value: unknown, aad: string, k: Keyring = defaultRing()): string {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k.keys.get(k.currentId)!, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return ['v1', k.currentId, b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}
export function decryptJson<T = any>(blob: string, aad: string, k: Keyring = defaultRing()): T {
  const [v, id, iv, tag, ct] = String(blob).split('.'); const key = k.keys.get(id);
  if (v !== 'v1' || !key || !iv || !tag || !ct) throw new Error('Cannot decrypt stored data');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, 'base64url'));
  try { return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')); } catch { throw new Error('Cannot decrypt stored data'); }
}
/** Ciphertext written with an old key should be re-encrypted with the current one. */
export const needsRotation = (blob: string, k: Keyring = defaultRing()) => blob.split('.')[1] !== k.currentId;
export const formAad = (form: string, employeeId: number) => `ams:${form}:${employeeId}`;

// ---------------------------------------------------------------- validation
export interface Validated<T> { ok: boolean; errors: string[]; clean: T }
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
export function normalizeSsn(s: unknown): string | null {
  const d = String(s ?? '').replace(/[\s-]/g, ''); if (!/^\d{9}$/.test(d)) return null;
  const a = d.slice(0, 3), g = d.slice(3, 5), n = d.slice(5);
  return a === '000' || a === '666' || +a >= 900 || g === '00' || n === '0000' ? null : d;
}
export const maskSsn = (d: string) => `***-**-${d.slice(-4)}`;
class V {
  errors: string[] = []; clean: Record<string, any> = {};
  constructor(private b: any) { this.b = b && typeof b === 'object' ? b : {}; }
  str(k: string, label: string, o: { min?: number; max?: number; req?: boolean; re?: RegExp } = {}) {
    const raw = this.b[k]; const v = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
    if (!v) { if (o.req !== false) this.errors.push(`${label} is required`); return ''; }
    if (v.length < (o.min ?? 1) || v.length > (o.max ?? 120)) { this.errors.push(`${label} must be ${o.min ?? 1}-${o.max ?? 120} characters`); return ''; }
    if (o.re && !o.re.test(v)) { this.errors.push(`${label} is not valid`); return ''; }
    this.clean[k] = v; return v;
  }
  enum(k: string, label: string, vals: string[]) { const v = String(this.b[k] ?? ''); if (!vals.includes(v)) { this.errors.push(`${label} is not valid`); return ''; } this.clean[k] = v; return v; }
  date(k: string, label: string, o: { req?: boolean; notFuture?: boolean; future?: boolean; today?: string } = {}) {
    const raw = this.b[k]; if (raw == null || raw === '') { if (o.req !== false) this.errors.push(`${label} is required`); return ''; }
    const v = isoDate(raw); if (!v) { this.errors.push(`${label} must be a valid date`); return ''; }
    const t = o.today ?? todayStr(); if (o.notFuture && v > t) { this.errors.push(`${label} cannot be in the future`); return ''; } if (o.future && v <= t) { this.errors.push(`${label} must be in the future`); return ''; }
    this.clean[k] = v; return v;
  }
  num(k: string, label: string, max = 1e7) { const raw = this.b[k]; if (raw == null || raw === '') { this.clean[k] = 0; return 0; } const n = Number(raw); if (!Number.isFinite(n) || n < 0 || n > max) { this.errors.push(`${label} must be between 0 and ${max}`); return 0; } this.clean[k] = Math.round(n * 100) / 100; return n; }
  bool(k: string) { const v = this.b[k] === true; this.clean[k] = v; return v; }
  must(k: string, label: string) { if (this.b[k] !== true) this.errors.push(`${label} is required`); this.clean[k] = this.b[k] === true; }
  ssn(k: string, req: boolean) { const raw = this.b[k]; if (raw == null || raw === '') { if (req) this.errors.push('Social Security number is required'); return; } const n = normalizeSsn(raw); if (!n) this.errors.push('Social Security number is not valid'); else this.clean[k] = n; }
  done<T>(): Validated<T> { return { ok: !this.errors.length, errors: this.errors, clean: this.clean as T }; }
}
const ZIP = /^\d{5}(-\d{4})?$/, PHONE = /^[0-9+()\-. ]{7,20}$/, EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const address = (v: V) => { v.str('street', 'Street', { max: 120 }); v.str('city', 'City', { max: 80 }); const s = v.str('state', 'State', { min: 2, max: 2 }).toUpperCase(); if (s && !STATES.has(s)) v.errors.push('State is not valid'); else if (s) v.clean.state = s; v.str('zip', 'ZIP code', { re: ZIP, max: 10 }); };
export const CITIZENSHIP = ['citizen', 'noncitizen_national', 'lawful_permanent_resident', 'authorized_alien'];

/** I-9 Section 1 (employee). Never asks for specific documents or proof of citizenship. */
export function validateI9S1(b: any, today = todayStr()): Validated<any> {
  const v = new V(b); v.str('lastName', 'Last name', { max: 80 }); v.str('firstName', 'First name', { max: 80 }); v.str('middleInitial', 'Middle initial', { req: false, max: 1 }); v.str('otherLastNames', 'Other last names', { req: false });
  address(v); const dob = v.date('dob', 'Date of birth', { notFuture: true, today });
  if (dob) { const age = (ms(today) - ms(dob)) / (365.25 * MS_DAY); if (age < 14 || age > 100) v.errors.push('Date of birth is not valid'); }
  v.ssn('ssn', false); v.str('email', 'Email', { req: false, re: EMAIL, max: 254 }); v.str('phone', 'Phone', { req: false, re: PHONE, max: 20 });
  const st = v.enum('citizenshipStatus', 'Citizenship or immigration status', CITIZENSHIP);
  if (st === 'lawful_permanent_resident') v.str('alienNumber', 'USCIS A-Number', { re: /^A?\d{7,9}$/i, max: 10 });
  if (st === 'authorized_alien') {
    v.date('workAuthExpiry', 'Work authorization expiry', { req: false, future: true, today }); v.str('alienNumber', 'USCIS A-Number', { req: false, re: /^A?\d{7,9}$/i, max: 10 });
    v.str('i94Number', 'I-94 number', { req: false, re: /^[A-Za-z0-9]{9,11}$/, max: 11 }); v.str('passportNumber', 'Foreign passport number', { req: false, max: 20 }); v.str('passportCountry', 'Country of issuance', { req: false, max: 60 });
    if (!v.clean.alienNumber && !v.clean.i94Number && !v.clean.passportNumber) v.errors.push('Provide an A-Number, I-94 number or foreign passport number');
  }
  v.must('attestation', 'The attestation under penalty of perjury'); v.str('signedName', 'Typed signature', { min: 2, max: 120 }); return v.done();
}
export const FILING = ['single', 'married', 'head'];
/** W-4 (employee). Contains SSN: always stored encrypted. */
export function validateW4(b: any, today = todayStr()): Validated<any> {
  const v = new V(b); v.str('firstName', 'First name', { max: 80 }); v.str('lastName', 'Last name', { max: 80 }); v.ssn('ssn', true); address(v); v.enum('filingStatus', 'Filing status', FILING);
  v.bool('multipleJobs'); v.num('dependentsCredit', 'Dependents credit'); v.num('otherIncome', 'Other income'); v.num('deductions', 'Deductions'); v.num('extraWithholding', 'Extra withholding', 1e6); v.bool('claimExempt');
  v.must('attestation', 'The attestation under penalty of perjury'); v.str('signedName', 'Typed signature', { min: 2, max: 120 }); v.clean.taxYear = +today.slice(0, 4); return v.done();
}
/** I-9 Section 2 (HR/employer rep). `late` is true when completed after 3 business days from the first day of employment. */
export function validateI9S2(b: any, today = todayStr()): Validated<any> & { late: boolean; deadline: string | null } {
  const v = new V(b); const choice = v.enum('documentChoice', 'Document choice', ['list_a', 'list_b_and_c']);
  const first = v.date('firstDayOfEmployment', 'First day of employment', { today }); v.date('examinedOn', 'Date documents were examined', { notFuture: true, today }); v.str('employerRepName', 'Employer representative name', { min: 2, max: 120 });
  const docs: any[] = Array.isArray(b?.documents) ? b.documents : []; const clean: any[] = [];
  for (const d of docs.slice(0, 3)) {
    const x = new V(d); const lt = x.enum('listType', 'Document list', ['A', 'B', 'C']); x.str('title', 'Document title', { max: 120 }); x.str('issuingAuthority', 'Issuing authority', { max: 120 }); x.str('documentNumber', 'Document number', { max: 40 }); x.date('expiry', 'Document expiry', { req: false, today });
    v.errors.push(...x.errors); clean.push({ ...x.clean, listType: lt });
  }
  const lists = clean.map((d) => d.listType).sort().join('');
  if (choice === 'list_a' && lists !== 'A') v.errors.push('List A requires exactly one List A document');
  if (choice === 'list_b_and_c' && lists !== 'BC') v.errors.push('Provide one List B and one List C document');
  v.clean.documents = clean; v.must('attestation', 'The employer attestation');
  const deadline = first ? addBusinessDays(first, 3) : null; const out = v.done<any>();
  return { ...out, late: !!deadline && today > deadline, deadline };
}

// ---------------------------------------------------------------- checklist templates
export type Owner = 'employee' | 'manager' | 'hr';
export interface TaskDef { key: string; title: string; ownerRole: Owner; team?: string; mandatory: boolean; auto: boolean; dueBd?: number; dueDays?: number }
/** `auto` = completed by the system when the underlying form/action is done; it cannot be ticked by hand. */
export const ONBOARDING_TEMPLATE: TaskDef[] = [
  { key: 'i9_s1', title: 'Complete I-9 Section 1', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 0 },
  { key: 'w4', title: 'Fill W-4 digitally', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 3 },
  { key: 'handbook', title: 'Read and e-sign handbook and policies', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 3 },
  { key: 'emergency', title: 'Add emergency contact', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 3 },
  { key: 'i9_s2', title: 'Complete I-9 Section 2 and review documents', ownerRole: 'hr', mandatory: true, auto: true, dueBd: 3 },
  { key: 'w4_verify', title: 'Verify W-4 received', ownerRole: 'hr', mandatory: true, auto: false, dueBd: 3 },
  { key: 'assign', title: 'Assign manager and equipment', ownerRole: 'hr', mandatory: true, auto: true, dueBd: 3 },
  { key: 'mgr_ack', title: 'Acknowledge new team member', ownerRole: 'manager', mandatory: false, auto: false, dueBd: 3 },
];
export const OFFBOARDING_TEMPLATE: TaskDef[] = [
  { key: 'handover', title: 'Hand over work and tasks', ownerRole: 'manager', mandatory: true, auto: false, dueDays: 0 },
  { key: 'collect_assets', title: 'Collect assets and complete return checklist', ownerRole: 'hr', team: 'IT / Asset owner', mandatory: true, auto: false, dueDays: 0 },
  { key: 'revoke_access', title: 'Revoke access on termination date', ownerRole: 'hr', team: 'IT / Asset owner', mandatory: true, auto: true, dueDays: 0 },
  { key: 'final_pay', title: 'Close final pay sheet and export via payroll', ownerRole: 'hr', team: 'Finance', mandatory: true, auto: false, dueDays: 5 },
  { key: 'benefits_notice', title: 'Send benefits and COBRA notice', ownerRole: 'hr', mandatory: true, auto: false, dueDays: 5 },
  { key: 'exit_interview', title: 'Exit interview', ownerRole: 'hr', mandatory: false, auto: false, dueDays: 0 },
  { key: 'retention', title: 'Set record retention date', ownerRole: 'hr', mandatory: true, auto: true, dueDays: 5 },
];
export function buildChecklist(kind: 'onboarding' | 'offboarding', anchor: string) {
  return (kind === 'onboarding' ? ONBOARDING_TEMPLATE : OFFBOARDING_TEMPLATE).map((t) => ({ ...t, dueDate: t.dueBd !== undefined ? addBusinessDays(anchor, t.dueBd) : addDays(anchor, t.dueDays ?? 0) }));
}
export const TERMINATION_REASONS = ['resignation', 'layoff', 'position_eliminated', 'end_of_contract', 'performance', 'misconduct', 'retirement', 'other'];
export const CREDENTIAL_TYPES = ['License', 'Certification', 'Work authorization', 'Training', 'Insurance', 'Other'];
export const HANDBOOK_VERSION = '2026.1';
