import { useState } from 'react';
import { api, useLoad } from './api';
import { Title, Table, Tag, Td } from './pages';

/** S8: versioned compliance rules. A change is a new version with an effective date, never an edit. */
export function RulesPage() {
  const [rules, load] = useLoad('/compliance-rules'); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState<any>({ key: 'final_pay', jurisdiction: 'TX', effectiveDate: '', verified: false, sourceUrl: '', legalOwner: '', payoutAccruedLeave: false, payoutSick: false, deadline: '', json: '{}' });
  const save = async () => {
    try {
      const value = f.key === 'final_pay' ? { payoutAccruedLeave: f.payoutAccruedLeave, payoutSick: f.payoutSick, deadline: f.deadline } : JSON.parse(f.json || '{}');
      await api('/compliance-rules', 'POST', { key: f.key, jurisdiction: f.jurisdiction, effectiveDate: f.effectiveDate, verified: f.verified, sourceUrl: f.sourceUrl, legalOwner: f.legalOwner, value });
      setMsg({ ok: true, text: 'New version saved' }); load();
    } catch (e: any) { setMsg({ ok: false, text: e instanceof SyntaxError ? 'The value is not valid JSON' : e.message }); }
  };
  return (<div className="space-y-5"><Title>Compliance rules</Title>
    {msg && <p className={msg.ok ? 'alert-ok' : 'alert-warn'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    <p className="hint">Rules are versioned by work state or city and effective date. Nothing is assumed: if a state has no rule, the system sends the case to review. Confirm every rule with counsel before marking it verified.</p>
    <div className="card space-y-3"><h2 className="font-semibold">Add a rule version</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <input className="input" placeholder="Rule key (e.g. final_pay)" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
        <input className="input" placeholder="Jurisdiction: US, CA or CA:Los Angeles" value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })} />
        <input className="input" type="date" aria-label="Effective date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} />
        <input className="input" placeholder="Legal owner" value={f.legalOwner} onChange={(e) => setF({ ...f, legalOwner: e.target.value })} /></div>
      <input className="input" placeholder="Source URL (law or agency page)" value={f.sourceUrl} onChange={(e) => setF({ ...f, sourceUrl: e.target.value })} />
      {f.key === 'final_pay' ? (<div className="space-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.payoutAccruedLeave} onChange={(e) => setF({ ...f, payoutAccruedLeave: e.target.checked })} />Accrued vacation / PTO must be paid out at separation</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.payoutSick} onChange={(e) => setF({ ...f, payoutSick: e.target.checked })} />Accrued sick leave must be paid out</label>
        <input className="input" placeholder="Final pay deadline (describe)" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></div>)
        : <textarea className="input font-mono text-xs" rows={4} value={f.json} onChange={(e) => setF({ ...f, json: e.target.value })} aria-label="Rule value (JSON)" />}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.verified} onChange={(e) => setF({ ...f, verified: e.target.checked })} />Verified by counsel</label>
      <button className="btn" onClick={save}>Save new version</button></div>
    <Table head={['Rule', 'Jurisdiction', 'Version', 'Effective', 'Verified', 'Owner', 'Value']}>
      {(Array.isArray(rules) ? rules : []).map((r: any) => (<tr key={r.id}><Td>{r.key}</Td><Td>{r.jurisdiction}</Td><Td>v{r.version}</Td><Td>{r.effectiveDate}</Td><Td><Tag s={r.verified ? 'verified' : 'pending'} /></Td><Td>{r.legalOwner}</Td><Td className="max-w-xs truncate font-mono text-xs">{JSON.stringify(r.value)}</Td></tr>))}
    </Table></div>);
}
