import { useEffect, useState } from 'react';
const base = (import.meta as any).env.VITE_API || 'http://localhost:4000/api';
export const user = () => JSON.parse(localStorage.getItem('user') || 'null');
export async function api(path: string, method = 'GET', body?: any, raw = false) {
  // Session = httpOnly cookie (JavaScript cannot read it). The custom header is the CSRF check the server requires on writes.
  const r = await fetch(base + path, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ams' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/public/')) { localStorage.clear(); location.reload(); }
  if (raw) return r.text();
  const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong'), { status: r.status, data: d }); return d;
}
export function useLoad(path: string) {
  const [d, setD] = useState<any>(null);
  const load = () => api(path).then(setD).catch(() => setD([]));
  useEffect(() => { load(); }, [path]);
  return [d, load] as const;
}
