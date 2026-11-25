"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HANDBOOK_VERSION = exports.CREDENTIAL_TYPES = exports.TERMINATION_REASONS = exports.OFFBOARDING_TEMPLATE = exports.ONBOARDING_TEMPLATE = exports.FILING = exports.CITIZENSHIP = exports.maskSsn = exports.formAad = exports.needsRotation = exports.resetRing = exports.defaultRing = exports.credentialBucket = exports.REMINDER_DAYS = exports.defaultRetentionUntil = exports.addDays = exports.daysUntil = exports.todayStr = exports.isoDate = void 0;
exports.addBusinessDays = addBusinessDays;
exports.addYears = addYears;
exports.reminderThreshold = reminderThreshold;
exports.loadKeyring = loadKeyring;
exports.encryptJson = encryptJson;
exports.decryptJson = decryptJson;
exports.normalizeSsn = normalizeSsn;
exports.validateI9S1 = validateI9S1;
exports.validateW4 = validateW4;
exports.validateI9S2 = validateI9S2;
exports.buildChecklist = buildChecklist;
/**
 * Pure logic for the employee lifecycle modules (P5 onboarding, P7 credentials, P8 offboarding).
 * No database or framework imports here: everything is deterministic and unit-tested.
 */
const node_crypto_1 = __importDefault(require("node:crypto"));
// ---------------------------------------------------------------- dates
const MS_DAY = 864e5;
const isoDate = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s))
        return null;
    const d = new Date(`${s}T00:00:00Z`);
    return !isNaN(+d) && d.toISOString().slice(0, 10) === s ? s : null;
};
exports.isoDate = isoDate;
const ms = (s) => Date.parse(`${s}T00:00:00Z`);
const fmt = (n) => new Date(n).toISOString().slice(0, 10);
const todayStr = (now = new Date()) => now.toISOString().slice(0, 10);
exports.todayStr = todayStr;
const daysUntil = (target, today) => Math.round((ms(target) - ms(today)) / MS_DAY);
exports.daysUntil = daysUntil;
const addDays = (d, n) => fmt(ms(d) + n * MS_DAY);
exports.addDays = addDays;
/** Weekends are skipped. Public holidays are NOT modelled (documented gap). */
function addBusinessDays(d, n) {
    let cur = ms(d), left = n;
    while (left > 0) {
        cur += MS_DAY;
        const dow = new Date(cur).getUTCDay();
        if (dow !== 0 && dow !== 6)
            left--;
    }
    return fmt(cur);
}
function addYears(d, n) {
    const [y, m, day] = d.split('-').map(Number);
    const t = new Date(Date.UTC(y + n, m - 1, day));
    if (t.getUTCMonth() !== m - 1)
        t.setUTCDate(0); // Feb 29 -> Feb 28
    return t.toISOString().slice(0, 10);
}
/** Default record retention: later of (hire + 3y, term + 1y) for I-9 and term + 4y for payroll tax records. HR may override; confirm with counsel. */
const defaultRetentionUntil = (hire, term) => [addYears(hire, 3), addYears(term, 1), addYears(term, 4)].sort().at(-1);
exports.defaultRetentionUntil = defaultRetentionUntil;
// ---------------------------------------------------------------- P7 credential reminders
exports.REMINDER_DAYS = [90, 60, 30, 7];
/**
 * Which reminder (if any) is due now. Sends each threshold at most once: returns the smallest threshold
 * that daysLeft has reached, only when it is lower than the last one already sent. Expiry itself (<= 0) is handled separately.
 */
function reminderThreshold(daysLeft, lastSent) {
    if (daysLeft <= 0)
        return null;
    const reached = exports.REMINDER_DAYS.filter((d) => daysLeft <= d);
    if (!reached.length)
        return null;
    const t = Math.min(...reached);
    return lastSent === null || t < lastSent ? t : null;
}
const credentialBucket = (daysLeft) => (daysLeft <= 0 ? 'expired' : daysLeft <= exports.REMINDER_DAYS[0] ? 'expiring_soon' : 'compliant');
exports.credentialBucket = credentialBucket;
const kid = (k) => node_crypto_1.default.createHash('sha256').update(k).digest('hex').slice(0, 8);
const parseKey = (b64) => { const k = Buffer.from(b64.trim(), 'base64'); if (k.length !== 32)
    throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded'); return k; };
/** DATA_ENCRYPTION_KEY = current key. DATA_ENCRYPTION_KEY_OLD = comma separated previous keys (decrypt only), used during rotation. */
function loadKeyring(env = process.env) {
    if (!env.DATA_ENCRYPTION_KEY)
        throw new Error('DATA_ENCRYPTION_KEY is not set');
    const cur = parseKey(env.DATA_ENCRYPTION_KEY);
    const keys = new Map([[kid(cur), cur]]);
    for (const o of (env.DATA_ENCRYPTION_KEY_OLD || '').split(',').filter((x) => x.trim())) {
        const k = parseKey(o);
        keys.set(kid(k), k);
    }
    return { currentId: kid(cur), keys };
}
let ring = null;
const defaultRing = () => (ring ||= loadKeyring());
exports.defaultRing = defaultRing;
const resetRing = () => { ring = null; };
exports.resetRing = resetRing;
const b64u = (b) => b.toString('base64url');
/** Output: v1.<keyId>.<iv>.<tag>.<ciphertext>. `aad` binds the ciphertext to its row (swapping rows breaks decryption). */
function encryptJson(value, aad, k = (0, exports.defaultRing)()) {
    const iv = node_crypto_1.default.randomBytes(12), c = node_crypto_1.default.createCipheriv('aes-256-gcm', k.keys.get(k.currentId), iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return ['v1', k.currentId, b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}
function decryptJson(blob, aad, k = (0, exports.defaultRing)()) {
    const [v, id, iv, tag, ct] = String(blob).split('.');
    const key = k.keys.get(id);
    if (v !== 'v1' || !key || !iv || !tag || !ct)
        throw new Error('Cannot decrypt stored data');
    const d = node_crypto_1.default.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
        return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
    }
    catch {
        throw new Error('Cannot decrypt stored data');
    }
}
/** Ciphertext written with an old key should be re-encrypted with the current one. */
const needsRotation = (blob, k = (0, exports.defaultRing)()) => blob.split('.')[1] !== k.currentId;
exports.needsRotation = needsRotation;
const formAad = (form, employeeId) => `ams:${form}:${employeeId}`;
exports.formAad = formAad;
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
function normalizeSsn(s) {
    const d = String(s ?? '').replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(d))
        return null;
    const a = d.slice(0, 3), g = d.slice(3, 5), n = d.slice(5);
    return a === '000' || a === '666' || +a >= 900 || g === '00' || n === '0000' ? null : d;
}
const maskSsn = (d) => `***-**-${d.slice(-4)}`;
exports.maskSsn = maskSsn;
class V {
    b;
    errors = [];
    clean = {};
    constructor(b) {
        this.b = b;
        this.b = b && typeof b === 'object' ? b : {};
    }
    str(k, label, o = {}) {
        const raw = this.b[k];
        const v = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
        if (!v) {
            if (o.req !== false)
                this.errors.push(`${label} is required`);
            return '';
        }
        if (v.length < (o.min ?? 1) || v.length > (o.max ?? 120)) {
            this.errors.push(`${label} must be ${o.min ?? 1}-${o.max ?? 120} characters`);
            return '';
        }
        if (o.re && !o.re.test(v)) {
            this.errors.push(`${label} is not valid`);
            return '';
        }
        this.clean[k] = v;
        return v;
    }
    enum(k, label, vals) { const v = String(this.b[k] ?? ''); if (!vals.includes(v)) {
        this.errors.push(`${label} is not valid`);
        return '';
    } this.clean[k] = v; return v; }
    date(k, label, o = {}) {
        const raw = this.b[k];
        if (raw == null || raw === '') {
            if (o.req !== false)
                this.errors.push(`${label} is required`);
            return '';
        }
        const v = (0, exports.isoDate)(raw);
        if (!v) {
            this.errors.push(`${label} must be a valid date`);
            return '';
        }
        const t = o.today ?? (0, exports.todayStr)();
        if (o.notFuture && v > t) {
            this.errors.push(`${label} cannot be in the future`);
            return '';
        }
        if (o.future && v <= t) {
            this.errors.push(`${label} must be in the future`);
            return '';
        }
        this.clean[k] = v;
        return v;
    }
    num(k, label, max = 1e7) { const raw = this.b[k]; if (raw == null || raw === '') {
        this.clean[k] = 0;
        return 0;
    } const n = Number(raw); if (!Number.isFinite(n) || n < 0 || n > max) {
        this.errors.push(`${label} must be between 0 and ${max}`);
        return 0;
    } this.clean[k] = Math.round(n * 100) / 100; return n; }
    bool(k) { const v = this.b[k] === true; this.clean[k] = v; return v; }
    must(k, label) { if (this.b[k] !== true)
        this.errors.push(`${label} is required`); this.clean[k] = this.b[k] === true; }
    ssn(k, req) { const raw = this.b[k]; if (raw == null || raw === '') {
        if (req)
            this.errors.push('Social Security number is required');
        return;
    } const n = normalizeSsn(raw); if (!n)
        this.errors.push('Social Security number is not valid');
    else
        this.clean[k] = n; }
    done() { return { ok: !this.errors.length, errors: this.errors, clean: this.clean }; }
}
const ZIP = /^\d{5}(-\d{4})?$/, PHONE = /^[0-9+()\-. ]{7,20}$/, EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const address = (v) => { v.str('street', 'Street', { max: 120 }); v.str('city', 'City', { max: 80 }); const s = v.str('state', 'State', { min: 2, max: 2 }).toUpperCase(); if (s && !STATES.has(s))
    v.errors.push('State is not valid');
else if (s)
    v.clean.state = s; v.str('zip', 'ZIP code', { re: ZIP, max: 10 }); };
exports.CITIZENSHIP = ['citizen', 'noncitizen_national', 'lawful_permanent_resident', 'authorized_alien'];
/** I-9 Section 1 (employee). Never asks for specific documents or proof of citizenship. */
function validateI9S1(b, today = (0, exports.todayStr)()) {
    const v = new V(b);
    v.str('lastName', 'Last name', { max: 80 });
    v.str('firstName', 'First name', { max: 80 });
    v.str('middleInitial', 'Middle initial', { req: false, max: 1 });
    v.str('otherLastNames', 'Other last names', { req: false });
    address(v);
    const dob = v.date('dob', 'Date of birth', { notFuture: true, today });
    if (dob) {
        const age = (ms(today) - ms(dob)) / (365.25 * MS_DAY);
        if (age < 14 || age > 100)
            v.errors.push('Date of birth is not valid');
    }
    v.ssn('ssn', false);
    v.str('email', 'Email', { req: false, re: EMAIL, max: 254 });
    v.str('phone', 'Phone', { req: false, re: PHONE, max: 20 });
    const st = v.enum('citizenshipStatus', 'Citizenship or immigration status', exports.CITIZENSHIP);
    if (st === 'lawful_permanent_resident')
        v.str('alienNumber', 'USCIS A-Number', { re: /^A?\d{7,9}$/i, max: 10 });
    if (st === 'authorized_alien') {
        v.date('workAuthExpiry', 'Work authorization expiry', { req: false, future: true, today });
        v.str('alienNumber', 'USCIS A-Number', { req: false, re: /^A?\d{7,9}$/i, max: 10 });
        v.str('i94Number', 'I-94 number', { req: false, re: /^[A-Za-z0-9]{9,11}$/, max: 11 });
        v.str('passportNumber', 'Foreign passport number', { req: false, max: 20 });
        v.str('passportCountry', 'Country of issuance', { req: false, max: 60 });
        if (!v.clean.alienNumber && !v.clean.i94Number && !v.clean.passportNumber)
            v.errors.push('Provide an A-Number, I-94 number or foreign passport number');
    }
    v.must('attestation', 'The attestation under penalty of perjury');
    v.str('signedName', 'Typed signature', { min: 2, max: 120 });
    return v.done();
}
exports.FILING = ['single', 'married', 'head'];
/** W-4 (employee). Contains SSN: always stored encrypted. */
function validateW4(b, today = (0, exports.todayStr)()) {
    const v = new V(b);
    v.str('firstName', 'First name', { max: 80 });
    v.str('lastName', 'Last name', { max: 80 });
    v.ssn('ssn', true);
    address(v);
    v.enum('filingStatus', 'Filing status', exports.FILING);
    v.bool('multipleJobs');
    v.num('dependentsCredit', 'Dependents credit');
    v.num('otherIncome', 'Other income');
    v.num('deductions', 'Deductions');
    v.num('extraWithholding', 'Extra withholding', 1e6);
    v.bool('claimExempt');
    v.must('attestation', 'The attestation under penalty of perjury');
    v.str('signedName', 'Typed signature', { min: 2, max: 120 });
    v.clean.taxYear = +today.slice(0, 4);
    return v.done();
}
/** I-9 Section 2 (HR/employer rep). `late` is true when completed after 3 business days from the first day of employment. */
function validateI9S2(b, today = (0, exports.todayStr)()) {
    const v = new V(b);
    const choice = v.enum('documentChoice', 'Document choice', ['list_a', 'list_b_and_c']);
    const first = v.date('firstDayOfEmployment', 'First day of employment', { today });
    v.date('examinedOn', 'Date documents were examined', { notFuture: true, today });
    v.str('employerRepName', 'Employer representative name', { min: 2, max: 120 });
    const docs = Array.isArray(b?.documents) ? b.documents : [];
    const clean = [];
    for (const d of docs.slice(0, 3)) {
        const x = new V(d);
        const lt = x.enum('listType', 'Document list', ['A', 'B', 'C']);
        x.str('title', 'Document title', { max: 120 });
        x.str('issuingAuthority', 'Issuing authority', { max: 120 });
        x.str('documentNumber', 'Document number', { max: 40 });
        x.date('expiry', 'Document expiry', { req: false, today });
        v.errors.push(...x.errors);
        clean.push({ ...x.clean, listType: lt });
    }
    const lists = clean.map((d) => d.listType).sort().join('');
    if (choice === 'list_a' && lists !== 'A')
        v.errors.push('List A requires exactly one List A document');
    if (choice === 'list_b_and_c' && lists !== 'BC')
        v.errors.push('Provide one List B and one List C document');
    v.clean.documents = clean;
    v.must('attestation', 'The employer attestation');
    const deadline = first ? addBusinessDays(first, 3) : null;
    const out = v.done();
    return { ...out, late: !!deadline && today > deadline, deadline };
}
/** `auto` = completed by the system when the underlying form/action is done; it cannot be ticked by hand. */
exports.ONBOARDING_TEMPLATE = [
    { key: 'i9_s1', title: 'Complete I-9 Section 1', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 0 },
    { key: 'w4', title: 'Fill W-4 digitally', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 3 },
    { key: 'handbook', title: 'Read and e-sign handbook and policies', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 3 },
    { key: 'emergency', title: 'Add emergency contact', ownerRole: 'employee', mandatory: true, auto: true, dueBd: 3 },
    { key: 'i9_s2', title: 'Complete I-9 Section 2 and review documents', ownerRole: 'hr', mandatory: true, auto: true, dueBd: 3 },
    { key: 'w4_verify', title: 'Verify W-4 received', ownerRole: 'hr', mandatory: true, auto: false, dueBd: 3 },
    { key: 'assign', title: 'Assign manager and equipment', ownerRole: 'hr', mandatory: true, auto: true, dueBd: 3 },
    { key: 'mgr_ack', title: 'Acknowledge new team member', ownerRole: 'manager', mandatory: false, auto: false, dueBd: 3 },
];
exports.OFFBOARDING_TEMPLATE = [
    { key: 'handover', title: 'Hand over work and tasks', ownerRole: 'manager', mandatory: true, auto: false, dueDays: 0 },
    { key: 'collect_assets', title: 'Collect assets and complete return checklist', ownerRole: 'hr', team: 'IT / Asset owner', mandatory: true, auto: false, dueDays: 0 },
    { key: 'revoke_access', title: 'Revoke access on termination date', ownerRole: 'hr', team: 'IT / Asset owner', mandatory: true, auto: true, dueDays: 0 },
    { key: 'final_pay', title: 'Close final pay sheet and export via payroll', ownerRole: 'hr', team: 'Finance', mandatory: true, auto: false, dueDays: 5 },
    { key: 'benefits_notice', title: 'Send benefits and COBRA notice', ownerRole: 'hr', mandatory: true, auto: false, dueDays: 5 },
    { key: 'exit_interview', title: 'Exit interview', ownerRole: 'hr', mandatory: false, auto: false, dueDays: 0 },
    { key: 'retention', title: 'Set record retention date', ownerRole: 'hr', mandatory: true, auto: true, dueDays: 5 },
];
function buildChecklist(kind, anchor) {
    return (kind === 'onboarding' ? exports.ONBOARDING_TEMPLATE : exports.OFFBOARDING_TEMPLATE).map((t) => ({ ...t, dueDate: t.dueBd !== undefined ? addBusinessDays(anchor, t.dueBd) : (0, exports.addDays)(anchor, t.dueDays ?? 0) }));
}
exports.TERMINATION_REASONS = ['resignation', 'layoff', 'position_eliminated', 'end_of_contract', 'performance', 'misconduct', 'retirement', 'other'];
exports.CREDENTIAL_TYPES = ['License', 'Certification', 'Work authorization', 'Training', 'Insurance', 'Other'];
exports.HANDBOOK_VERSION = '2026.1';
