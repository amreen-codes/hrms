import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api } from './api';

/** Header search: debounced call to /search (role-scoped on the server), Ctrl+K to focus, Escape to close. */
export function GlobalSearch() {
  const nav = useNavigate(); const ref = useRef<HTMLInputElement>(null); const [q, setQ] = useState(''); const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState('');
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  useEffect(() => {
    setErr(''); if (q.trim().length < 2) { setRows(null); return; }
    const t = setTimeout(() => api('/search?q=' + encodeURIComponent(q.trim())).then(setRows).catch((e) => { setRows([]); setErr(e.message); }), 250); return () => clearTimeout(t);
  }, [q]);
  const go = (name: string) => { setQ(''); setRows(null); nav('/employees?q=' + encodeURIComponent(name)); };
  return (
    <div className="relative hidden max-w-xl flex-1 sm:block">
      <Search size={16} className="absolute left-3 top-3 text-slate-400" aria-hidden="true" />
      <input ref={ref} className="input pl-9" role="combobox" aria-expanded={!!rows} aria-label="Search employees" placeholder="Search employees, departments... (Ctrl+K)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); setRows(null); } }} />
      {rows && (
        <ul role="listbox" className="absolute left-0 right-0 z-40 mt-2 max-h-80 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
          {err && <li className="p-3 text-sm text-red-600">{err}</li>}
          {!err && rows.length === 0 && <li className="p-3 text-sm text-slate-500">No matches.</li>}
          {rows.map((r) => <li key={r.id} role="option"><button className="block w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => go(r.name)}><b>{r.name}</b><span className="ml-2 text-xs text-slate-500">{r.title} {r.department && `· ${r.department}`}</span></button></li>)}
        </ul>
      )}
    </div>
  );
}
