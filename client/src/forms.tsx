import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { api, user } from './api';

// ---------- reusable form kit ----------
export const Field = ({ label, hint, span = 1, children }: any) => (
  <div className={span === 2 ? 'sm:col-span-2' : ''}><label className="label">{label}</label>{children}{hint && <p className="hint">{hint}</p>}</div>
);
export const Grid = ({ children }: any) => <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
export const Toggle = ({ on, set, label }: any) => (
  <button type="button" onClick={() => set(!on)} className="flex items-center gap-3 text-sm">
    <span className={`h-6 w-11 rounded-full p-0.5 transition ${on ? 'bg-brand' : 'bg-slate-300'}`}><span className={`block h-5 w-5 rounded-full bg-white shadow transition ${on ? 'translate-x-5' : ''}`} /></span>{label}
  </button>
);

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const FLOOR: Record<string, number> = { US: 35568, CA: 70304, WA: 80168.4, NY: 62353.2, CO: 57783.96, ME: 45300.32 };
const SICK = new Set('AK AZ CA CO CT DC IL ME MD MA MI MN NE NV NJ NM NY OR RI VT WA'.split(' '));
const money = (n: number) => '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const STEPS = ['Account', 'Job', 'Pay', 'Tax & bank', 'Benefits', 'Review'];

const blank = () => ({ fullName: '', email: '', role: 'employee', password: '', confirmPassword: '', phone: '',
  street: '', city: '', addrState: '', zip: '', ecName: '', ecRelation: '', ecPhone: '',
  department: '', title: '', type: 'full_time', hours: 40, startDate: new Date().toISOString().slice(0, 10), workState: 'TX', workCity: '', flsaExempt: false,
  payType: 'hourly', hourlyRate: '', annualSalary: '', frequency: 'biweekly', commissionPct: '', bonusEligible: false, bonusTarget: '', payReason: 'New hire',
  bankName: '', routing: '', account: '', acctType: 'checking',
  waive: false, medical: 'none', dental: false, vision: false, life: false, k401: '', hsa: false, dependents: [] as any[] });

// ---------- Add Employee wizard: P5 onboarding + P15 benefits + P16 sick leave + P17 pay ----------
export function EmployeeWizard({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const me = user(); const [step, setStep] = useState(0); const [f, setF] = useState<any>(blank()); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const annual = f.payType === 'salary' ? Number(f.annualSalary) || 0 : (Number(f.hourlyRate) || 0) * 2080;
  const floor = Math.max(FLOOR.US, FLOOR[f.workState] || 0);
  const exemptLow = f.flsaExempt && annual < floor;
  const aca = Number(f.hours) >= 30;
  const need: string[][] = [['fullName', 'email', 'password', 'confirmPassword'], ['department', 'title', 'startDate'], [f.payType === 'hourly' ? 'hourlyRate' : 'annualSalary'], [], [], []];
  const missing = need[step].filter((k) => !f[k]);
  const acctErr = () => (f.password.length < 12 ? 'Initial password must be at least 12 characters' : f.password !== f.confirmPassword ? 'Password and confirm password do not match' : '');
  const next = () => { if (missing.length) return setErr('Please fill the required fields: ' + missing.join(', ')); if (step === 0 && acctErr()) return setErr(acctErr()); if (step === 2 && exemptLow) return setErr(`Exempt salary in ${f.workState} must be at least ${money(floor)} a year`); setErr(''); setStep(step + 1); };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const { account, routing, password: _p, confirmPassword: _c, ...rest } = f;   // the password is sent once, never stored in the profile
      const created = await api('/employees', 'POST', { name: f.fullName.trim(), email: f.email, role: f.role, password: f.password, confirmPassword: f.confirmPassword, phone: f.phone, department: f.department, title: f.title, type: f.type, workState: f.workState, startDate: f.startDate,
        payType: f.payType, hourlyRate: f.payType === 'hourly' ? f.hourlyRate : (annual / 2080).toFixed(2), annualSalary: f.payType === 'salary' ? f.annualSalary : 0, flsaExempt: f.flsaExempt,
        profile: { ...rest, bank: { name: f.bankName, routingLast4: routing.slice(-4), accountLast4: account.slice(-4), type: f.acctType }, benefits: { waive: f.waive, medical: f.medical, dental: f.dental, vision: f.vision, life: f.life, k401: f.k401, hsa: f.hsa, dependents: f.dependents } } });
      if (created?.tempPassword) window.alert(`Account created.\n\nTemporary password (shown once):\n${created.tempPassword}\n\nShare it securely. They must change it at first login.`);
      onSaved(); onClose();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  const dep = (i: number, k: string, v: string) => setF({ ...f, dependents: f.dependents.map((d: any, j: number) => (j === i ? { ...d, [k]: v } : d)) });
  const I = (k: string, p: any = {}) => <input className="input" value={f[k]} onChange={s(k)} {...p} />;
  const Sel = (k: string, opts: any[]) => <select className="input" value={f[k]} onChange={s(k)}>{opts.map((o) => (Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={o}>{o}</option>))}</select>;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-navy-950/60 p-3 backdrop-blur-sm">
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="bg-gradient-to-r from-navy-900 to-navy-700 px-6 pb-4 pt-5 text-white">
          <div className="flex items-start justify-between"><div><div className="text-xs uppercase tracking-widest text-gold-400">P5 Onboarding · P15 · P16 · P17</div><h2 className="font-serif text-2xl">Add new employee / user</h2></div>
            <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 hover:bg-white/10"><X /></button></div>
          <ol className="mt-4 flex gap-1.5">{STEPS.map((t, i) => (<li key={t} className="flex-1"><div className={`h-1.5 rounded-full ${i <= step ? 'bg-gold-400' : 'bg-white/20'}`} /><div className={`mt-1.5 hidden text-[11px] sm:block ${i === step ? 'font-semibold' : 'text-slate-300'}`}>{i + 1}. {t}</div></li>))}</ol>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {step === 0 && <><h3 className="font-semibold">Sign-in account</h3><Grid><Field label="Full name *">{I('fullName', { autoComplete: 'off' })}</Field>
            <Field label="Email address *" hint="This is the person's login. It must be unique.">{I('email', { type: 'email', autoComplete: 'off' })}</Field>
            <Field label="Role *" hint={me.role === 'admin' ? 'Admin, HR, Manager or Employee.' : 'HR can add Managers and Employees.'}>{Sel('role', (me.role === 'admin' ? [['employee', 'Employee'], ['manager', 'Manager'], ['hr', 'HR'], ['admin', 'Admin']] : [['employee', 'Employee'], ['manager', 'Manager']]))}</Field>
            <div />
            <Field label="Initial password *" hint="At least 12 characters. The person must change it at first login.">{I('password', { type: 'password', autoComplete: 'new-password' })}</Field>
            <Field label="Confirm password *">{I('confirmPassword', { type: 'password', autoComplete: 'new-password' })}</Field>
            </Grid>
            <h3 className="pt-2 font-semibold">Contact</h3><Grid><Field label="Mobile phone">{I('phone', { type: 'tel', placeholder: '(555) 123-4567' })}</Field></Grid>
            <h3 className="pt-2 font-semibold">Home address</h3><Grid><Field label="Street" span={2}>{I('street')}</Field><Field label="City">{I('city')}</Field>
              <div className="grid grid-cols-2 gap-3"><Field label="State">{Sel('addrState', ['', ...STATES])}</Field><Field label="ZIP">{I('zip', { maxLength: 10 })}</Field></div></Grid>
            <h3 className="pt-2 font-semibold">Emergency contact</h3><Grid><Field label="Name">{I('ecName')}</Field><Field label="Relationship">{I('ecRelation')}</Field><Field label="Phone">{I('ecPhone', { type: 'tel' })}</Field></Grid></>}
          {step === 1 && <Grid><Field label="Department *">{I('department')}</Field><Field label="Job title *">{I('title')}</Field>
            <Field label="Employment type">{Sel('type', [['full_time', 'Full-time'], ['part_time', 'Part-time']])}</Field>
            <Field label="Scheduled hours per week" hint={aca ? 'Average 30+ hours: ACA full-time test applies (P19).' : 'Under 30 hours: part-time benefits rules apply (P19).'}>{I('hours', { type: 'number', min: 1, max: 60 })}</Field>
            <Field label="Start date *">{I('startDate', { type: 'date' })}</Field><Field label="Work state" hint="Sets overtime, sick leave and tax rules.">{Sel('workState', STATES)}</Field>
            <Field label="Work city / county" hint="Local sick leave laws may apply (e.g. Seattle, NYC).">{I('workCity')}</Field>
            <div className="flex items-end pb-2"><Toggle on={f.flsaExempt} set={s('flsaExempt')} label="Exempt from overtime (salaried, duties test passed)" /></div>
            {SICK.has(f.workState) ? <div className="alert-ok sm:col-span-2">{f.workState} has a paid sick leave law. Hours will accrue automatically from the first day (Appendix A2).</div> : <div className="alert-warn sm:col-span-2">{f.workState} has no statewide paid sick leave law. Company policy applies unless a city or county law does.</div>}</Grid>}
          {step === 2 && <Grid><Field label="Pay type">{Sel('payType', [['hourly', 'Hourly'], ['salary', 'Salary']])}</Field><Field label="Pay frequency">{Sel('frequency', [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']])}</Field>
            {f.payType === 'hourly' ? <Field label="Hourly rate (USD) *">{I('hourlyRate', { type: 'number', step: '0.01', min: 0 })}</Field> : <Field label="Annual salary (USD) *">{I('annualSalary', { type: 'number', step: '100', min: 0 })}</Field>}
            <Field label="Reason for pay">{Sel('payReason', ['New hire', 'Promotion', 'Annual review', 'Market adjustment'])}</Field>
            <Field label="Commission rate (%)" hint="Leave empty if not on commission (P9, P10).">{I('commissionPct', { type: 'number', step: '0.1', min: 0 })}</Field>
            <div className="flex items-end pb-2"><Toggle on={f.bonusEligible} set={s('bonusEligible')} label="Eligible for bonus plan (P18)" /></div>
            {f.bonusEligible && <Field label="Annual bonus target (USD)">{I('bonusTarget', { type: 'number', min: 0 })}</Field>}
            <div className="sm:col-span-2 text-sm text-slate-600">Estimated annual pay: <b>{money(annual)}</b> {f.flsaExempt && <>· exempt floor in {f.workState}: <b>{money(floor)}</b></>}</div>
            {exemptLow && <div className="alert-warn sm:col-span-2">Below the exempt salary floor. Mark this person non-exempt or raise the salary (P17).</div>}</Grid>}
          {step === 3 && <>
            <div className="alert-ok">The employee completes I-9 Section 1 and the W-4 after signing in. Their answers (date of birth, SSN, tax details) are encrypted and are not collected here. HR completes I-9 Section 2 within 3 business days. Do not ask for specific documents.</div>
            <h3 className="font-semibold">Direct deposit</h3><Grid><Field label="Bank name">{I('bankName')}</Field><Field label="Account type">{Sel('acctType', ['checking', 'savings'])}</Field>
              <Field label="Routing number" hint="Only the last 4 digits are stored.">{I('routing', { maxLength: 9, inputMode: 'numeric' })}</Field><Field label="Account number" hint="Only the last 4 digits are stored.">{I('account', { maxLength: 17, inputMode: 'numeric' })}</Field></Grid></>}
          {step === 4 && <><Toggle on={f.waive} set={s('waive')} label="Employee waives all benefits" />
            {!f.waive && (aca || f.type === 'full_time' ? <>
              <Grid><Field label="Medical plan">{Sel('medical', [['none', 'No medical'], ['employee', 'Employee only'], ['spouse', 'Employee + spouse'], ['children', 'Employee + children'], ['family', 'Family']])}</Field>
                <Field label="401(k) contribution (%)" hint="Employer match per plan document.">{I('k401', { type: 'number', min: 0, max: 100 })}</Field></Grid>
              <div className="flex flex-wrap gap-x-8 gap-y-3"><Toggle on={f.dental} set={s('dental')} label="Dental" /><Toggle on={f.vision} set={s('vision')} label="Vision" /><Toggle on={f.life} set={s('life')} label="Life and AD&D" /><Toggle on={f.hsa} set={s('hsa')} label="HSA / FSA" /></div>
              <div><div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Dependents</h3><button type="button" className="btn-ghost !py-1.5" onClick={() => setF({ ...f, dependents: [...f.dependents, { name: '', relation: 'child', dob: '' }] })}><Plus size={14} />Add</button></div>
                {f.dependents.map((d: any, i: number) => <div key={i} className="mb-2 grid gap-2 sm:grid-cols-[1fr_9rem_9rem_auto]"><input className="input" placeholder="Full name" value={d.name} onChange={(e) => dep(i, 'name', e.target.value)} />
                  <select className="input" value={d.relation} onChange={(e) => dep(i, 'relation', e.target.value)}><option>spouse</option><option>child</option><option>partner</option></select>
                  <input className="input" type="date" value={d.dob} onChange={(e) => dep(i, 'dob', e.target.value)} /><button type="button" aria-label="Remove" className="btn-ghost" onClick={() => setF({ ...f, dependents: f.dependents.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button></div>)}
                {f.dependents.length > 0 && <p className="hint">Marriage or birth certificates are requested as compliance tasks (due in 30 days).</p>}</div></> :
              <div className="alert-warn">Part-time under 30 hours: not ACA-eligible. Only plans with a lower hour limit apply. Sick leave and 401(k) long-term part-time rules still run (P19).</div>)}</>}
          {step === 5 && <div className="space-y-3 text-sm">{[['Employee', `${f.fullName} · ${f.email}`], ['Account', `${f.role.toUpperCase()} · initial password set (must be changed at first login)`], ['Job', `${f.title}, ${f.department} · ${f.type.replace('_', ' ')} · ${f.hours} h/wk`], ['Location', `${f.workCity || ''} ${f.workState}`], ['Start', f.startDate],
            ['Pay', `${f.payType === 'hourly' ? money(Number(f.hourlyRate)) + '/h' : money(annual) + '/yr'} · ${f.frequency}${f.commissionPct ? ' · ' + f.commissionPct + '% commission' : ''}${f.bonusEligible ? ' · bonus plan' : ''}`],
            ['Benefits', f.waive ? 'Waived' : `Medical: ${f.medical}${f.dental ? ', dental' : ''}${f.vision ? ', vision' : ''}${f.life ? ', life' : ''}${f.k401 ? ', 401(k) ' + f.k401 + '%' : ''} · ${f.dependents.length} dependents`]]
            .map(([k, v]) => <div key={k} className="flex justify-between gap-4 rounded-xl bg-slate-50 px-4 py-3"><span className="text-slate-500">{k}</span><span className="text-right font-medium">{v}</span></div>)}
            <div className="alert-ok">On save: employee record created, onboarding checklist generated (I-9, W-4, handbook e-sign, emergency contact, HR tasks), sick-leave balance for {f.workState}, audit log, onboarding status.</div></div>}
          {err && <p className="alert-warn !border-red-200 !bg-red-50 !text-red-700">{err}</p>}
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-6 py-4">
          <button className="btn-ghost" disabled={step === 0} onClick={() => { setErr(''); setStep(step - 1); }}><ChevronLeft size={16} />Back</button>
          {step < 5 ? <button className="btn" onClick={next}>Continue<ChevronRight size={16} /></button> : <button className="btn" disabled={busy} onClick={save}><Check size={16} />{busy ? 'Saving...' : 'Save and start onboarding'}</button>}
        </div>
      </div>
    </div>
  );
}
