import { useEffect, useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import { api } from './api';
import { Title, Table, Td } from './pages';

const base = (import.meta as any).env.VITE_API || 'http://localhost:4000/api';
const today = () => new Date().toISOString().slice(0, 10), ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

/** Reports: pick one, set the filters, preview the first rows, then download CSV or Excel. The server decides what each role may see. */
export function Reports() {
  const [list, setList] = useState<any[]>([]); const [key, setKey] = useState(''); const [f, setF] = useState({ from: ago(30), to: today(), period: '' });
  const [data, setData] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/reports').then((r) => { setList(r); setKey(r[0]?.key || ''); }).catch((e) => setErr(e.message)); }, []);
  const def = list.find((r) => r.key === key);
  const qs = (format: string) => { const p = new URLSearchParams({ format }); if (def?.params.includes('range')) { p.set('from', f.from); p.set('to', f.to); } if (def?.params.includes('period') && f.period) p.set('period', f.period); return p.toString(); };
  const preview = async () => { setBusy(true); setErr(''); setData(null); try { setData(await api(`/reports/${key}?${qs('json')}`)); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const download = async (format: 'csv' | 'xlsx') => {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`${base}/reports/${key}?${qs(format)}`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || `${key}.${format}`;
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e: any) { setErr(e.message); } setBusy(false);
  };
  useEffect(() => { setData(null); setErr(''); }, [key]);
  return (<div className="space-y-4"><Title>Reports and exports</Title>
    <div className="card space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="sm:col-span-2 text-sm font-medium">Report<select className="input mt-1" value={key} onChange={(e) => setKey(e.target.value)}>{list.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</select></label>
        {def?.params.includes('range') && <><label className="text-sm font-medium">From<input type="date" className="input mt-1" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="text-sm font-medium">To<input type="date" className="input mt-1" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label></>}
        {def?.params.includes('period') && <label className="text-sm font-medium">Pay period<input className="input mt-1" placeholder="2026-11 (blank = all)" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></label>}
      </div>
      {def && <p className="text-sm text-slate-500">{def.description}</p>}
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <div className="flex flex-wrap gap-2"><button className="btn" disabled={!key || busy} onClick={preview}>Preview</button>
        <button className="btn-ghost" disabled={!key || busy} onClick={() => download('csv')}><Download size={16} /> CSV</button>
        <button className="btn-ghost" disabled={!key || busy} onClick={() => download('xlsx')}><FileSpreadsheet size={16} /> Excel</button></div>
      <p className="text-xs text-slate-400">Downloads are recorded in the audit log. Reports contain personal data: store and share them carefully.</p>
    </div>
    {data && <div className="space-y-2"><div className="text-sm text-slate-500">{data.total} row{data.total === 1 ? '' : 's'}{data.previewOnly ? ` (showing the first ${data.rows.length}; download for everything)` : ''}{data.truncated ? ' | limited to 20,000 rows' : ''}</div>
      {data.rows.length === 0 ? <div className="card text-center text-sm text-slate-500">No data for these filters.</div> :
        <Table head={data.columns}>{data.rows.map((r: any[], i: number) => <tr key={i}>{r.map((c, j) => <Td key={j}>{c === null ? '' : String(c)}</Td>)}</tr>)}</Table>}</div>}
  </div>);
}
