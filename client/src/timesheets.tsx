import { useState } from 'react';
import { Clock, Coffee } from 'lucide-react';
import { api, useLoad, user } from './api';
import { Title, Table, Tag, Td } from './pages';

const isStaff = () => user().role !== 'employee';
const mondayOf = (d = new Date()) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const ymd = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const hrs = (n: any) => Number(n).toFixed(2);

export function Timesheets() {
  const me = user();
  const [status, loadStatus] = useLoad('/attendance/status');
  const [sheets, loadSheets] = useLoad('/timesheets');
  const [corr, loadCorr] = useLoad('/corrections');
  const [att] = useLoad('/attendance');
  const mon = mondayOf();
  const [p, setP] = useState({ periodStart: ymd(mon), periodEnd: ymd(new Date(mon.getTime() + 6 * 864e5)) });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fixFor, setFixFor] = useState<any>(null);
  const [f, setF] = useState<any>({ attendanceId: '', newClockIn: '', newClockOut: '', reason: '' });

  const run = async (fn: () => Promise<any>, ok: string) => {
    try { await fn(); setMsg({ ok: true, text: ok }); } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    loadStatus(); loadSheets(); loadCorr();
  };
  const decide = (url: string, approve: boolean) => {
    const comment = approve ? '' : window.prompt('Reason for rejecting (required)') || '';
    if (!approve && !comment) return;
    run(() => api(url, 'POST', { approve, comment }), approve ? 'Approved' : 'Rejected');
  };
  const myShifts = (att || []).filter((a: any) => a.employeeId === me.id && a.clockOut && fixFor && a.date >= fixFor.periodStart && a.date <= fixFor.periodEnd);

  return (
    <div className="space-y-5">
      <Title>Timesheets</Title>
      {msg && <p className={msg.ok ? 'alert-ok' : 'alert-warn'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3">
          <h2 className="flex items-center gap-2 font-semibold"><Clock size={18} className="text-brand" />Clock</h2>
          <p className="text-sm text-slate-600">{status?.clockedIn ? `Clocked in since ${new Date(status.since).toLocaleTimeString()}${status.onBreak ? ' · on break' : ''}` : 'You are not clocked in.'}</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => run(() => api('/attendance/clock', 'POST'), status?.clockedIn ? 'Clocked out' : 'Clocked in')}>{status?.clockedIn ? 'Clock out' : 'Clock in'}</button>
            {status?.clockedIn && <button className="btn-ghost" onClick={() => run(() => api('/attendance/break', 'POST', { action: status.onBreak ? 'end' : 'start' }), status.onBreak ? 'Break ended' : 'Break started')}><Coffee size={16} className="mr-1 inline" />{status.onBreak ? 'End break' : 'Start break'}</button>}
          </div>
        </div>
        <div className="card space-y-3">
          <h2 className="font-semibold">Submit timesheet for pay period</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">From<input className="input" type="date" value={p.periodStart} onChange={(e) => setP({ ...p, periodStart: e.target.value })} /></label>
            <label className="text-sm">To<input className="input" type="date" value={p.periodEnd} onChange={(e) => setP({ ...p, periodEnd: e.target.value })} /></label>
          </div>
          <button className="btn" onClick={() => run(() => api('/timesheets', 'POST', p), 'Timesheet submitted for approval')}>Submit timesheet</button>
          <p className="hint">Overtime is calculated for your work state (weekly over 40 h; California also daily).</p>
        </div>
      </div>

      <h2 className="font-semibold">Timesheets</h2>
      <Table head={['Employee', 'Period', 'Regular', 'OT', 'Double', 'Status', 'Payroll', 'Note', '']}>
        {(sheets || []).map((t: any) => (
          <tr key={t.id}>
            <Td>{t.employeeName}</Td><Td>{t.periodStart} → {t.periodEnd}</Td><Td>{hrs(t.regularHours)}</Td><Td>{hrs(t.otHours)}</Td><Td>{hrs(t.dtHours)}</Td>
            <Td><Tag s={t.status} />{t.version > 1 && <span className="ml-1 text-xs text-slate-500">v{t.version}</span>}</Td>
            <Td>{t.payrollStatus}</Td><Td>{t.comment}</Td>
            <Td>
              <span className="flex flex-wrap gap-2">
                {t.status === 'submitted' && isStaff() && t.employeeId !== me.id && <>
                  <button className="btn !px-2 !py-1" onClick={() => decide(`/timesheets/${t.id}/decide`, true)}>Approve</button>
                  <button className="btn-ghost !px-2 !py-1" onClick={() => decide(`/timesheets/${t.id}/decide`, false)}>Reject</button></>}
                {t.employeeId === me.id && t.status === 'rejected' && <button className="btn !px-2 !py-1" onClick={() => run(() => api('/timesheets', 'POST', { periodStart: t.periodStart, periodEnd: t.periodEnd }), 'Resubmitted')}>Resubmit</button>}
                {t.employeeId === me.id && t.status === 'approved' && <button className="btn-ghost !px-2 !py-1" onClick={() => { setFixFor(t); setF({ attendanceId: '', newClockIn: '', newClockOut: '', reason: '' }); }}>Request correction</button>}
              </span>
            </Td>
          </tr>
        ))}
      </Table>

      {fixFor && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Correction for {fixFor.periodStart} → {fixFor.periodEnd}</h2>
          <select className="input" value={f.attendanceId} onChange={(e) => setF({ ...f, attendanceId: e.target.value })}>
            <option value="">Choose a shift</option>
            {myShifts.map((a: any) => <option key={a.id} value={a.id}>{a.date} · {new Date(a.clockIn).toLocaleTimeString()} – {new Date(a.clockOut).toLocaleTimeString()}</option>)}
          </select>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Correct clock-in<input className="input" type="datetime-local" value={f.newClockIn} onChange={(e) => setF({ ...f, newClockIn: e.target.value })} /></label>
            <label className="text-sm">Correct clock-out<input className="input" type="datetime-local" value={f.newClockOut} onChange={(e) => setF({ ...f, newClockOut: e.target.value })} /></label>
          </div>
          <input className="input" placeholder="Reason (required)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <div className="flex gap-2">
            <button className="btn" onClick={() => run(async () => {
              await api(`/timesheets/${fixFor.id}/corrections`, 'POST', { attendanceId: +f.attendanceId, newClockIn: new Date(f.newClockIn).toISOString(), newClockOut: new Date(f.newClockOut).toISOString(), reason: f.reason }); setFixFor(null);
            }, 'Correction sent for approval')}>Send for approval</button>
            <button className="btn-ghost" onClick={() => setFixFor(null)}>Cancel</button>
          </div>
        </div>
      )}

      <h2 className="font-semibold">Corrections after approval</h2>
      <Table head={['Employee', 'Reason', 'Change', 'Status', 'Applied to', '']}>
        {(corr || []).map((c: any) => (
          <tr key={c.id}>
            <Td>{c.employeeName}</Td><Td>{c.reason}</Td>
            <Td className="text-xs">{new Date(c.oldClockIn).toLocaleString()} – {new Date(c.oldClockOut).toLocaleTimeString()}<br />→ {new Date(c.newClockIn).toLocaleString()} – {new Date(c.newClockOut).toLocaleTimeString()}</Td>
            <Td><Tag s={c.status} /></Td><Td>{c.appliedTo ? `${c.appliedTo.replace('_', ' ')} (${hrs(c.hoursDelta)} h)` : '—'}</Td>
            <Td>{c.status === 'pending' && isStaff() && c.employeeId !== me.id && <span className="flex gap-2">
              <button className="btn !px-2 !py-1" onClick={() => decide(`/corrections/${c.id}/decide`, true)}>Approve</button>
              <button className="btn-ghost !px-2 !py-1" onClick={() => decide(`/corrections/${c.id}/decide`, false)}>Reject</button></span>}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
