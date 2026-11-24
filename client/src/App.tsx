import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { Home, Users, Clock, FileText, CalendarDays, Wallet, ShieldCheck, Briefcase, HeartPulse, Stethoscope, Bot, Menu, X, LogOut, UserCheck, BadgeCheck, UserMinus, Coins, CalendarClock, BarChart3, CreditCard } from 'lucide-react';
import { api, user } from './api';
import { SidebarBrand, PrintHeader, Logo } from './brand';
import { Login, ForceChangePassword, AcceptInvite, PlatformShell, loadMe, doLogout } from './auth';
import { RulesPage } from './rules';
import { UiClaims, Insurance } from './compliance';
import { Training, Performance } from './people';
import { Payroll, Compliance } from './finance';
import { PartTime, Schedules, SickAdmin, BenefitsAdmin, Enrollment } from './hrhub';
import { Benefits, SickLeave } from './modules';
import { Timesheets } from './timesheets';
import { GlobalSearch } from './search';
import { Onboarding, Credentials, Offboarding, NotificationBell } from './lifecycle';
import { Reports } from './reports';
import { Billing } from './billing';
import { Dashboard, Employees, Attendance, Leave, Assistant } from './pages';
import { Compensation } from './compensation';
import { Recruitment, MyInterviews, Careers } from './recruitment';

const nav = [['/', 'Dashboard', Home], ['/employees', 'Employees', Users], ['/attendance', 'Attendance', Clock], ['/timesheets', 'Timesheets', FileText], ['/leave', 'Leave Management', CalendarDays],
  ['/benefits', 'Benefits', HeartPulse], ['/sick-leave', 'Sick Leave', Stethoscope], ['/payroll', 'Payroll', Wallet], ['/compensation', 'Compensation', Coins], ['/onboarding', 'Onboarding', UserCheck], ['/credentials', 'Credentials', BadgeCheck], ['/reports', 'Reports', BarChart3], ['/billing', 'Billing', CreditCard], ['/rules', 'Compliance rules', ShieldCheck], ['/training', 'Training', BadgeCheck], ['/performance', 'Performance', UserCheck], ['/ui-claims', 'Unemployment claims', FileText], ['/insurance', 'Insurance register', ShieldCheck], ['/enrollment', 'Enrollment', HeartPulse], ['/schedules', 'Schedules', CalendarDays], ['/part-time', 'Part-time review', Users], ['/benefits-admin', 'Benefit plans', HeartPulse], ['/sick-admin', 'Sick leave admin', Stethoscope], ['/offboarding', 'Offboarding', UserMinus], ['/compliance', 'Compliance', ShieldCheck], ['/recruitment', 'Recruitment', Briefcase], ['/interviews', 'My Interviews', CalendarClock], ['/assistant', 'AI HR Assistant', Bot]] as any[];

function Shell() {
  const [open, setOpen] = useState(false); const u = user();
  /** Menu by role. The server is the real gate (every list is already limited to what the person may see); this keeps people from being shown pages that are not meant for them. */
  const PERSONAL = ['/', '/attendance', '/timesheets', '/leave', '/benefits', '/sick-leave', '/enrollment', '/onboarding', '/credentials', '/training', '/performance', '/schedules', '/assistant'];
  const MANAGER = [...PERSONAL, '/employees', '/compensation', '/offboarding', '/compliance', '/recruitment', '/interviews', '/reports'];
  const pages: string[] | null = u.role === 'employee' ? PERSONAL : u.role === 'manager' ? MANAGER : null;     // hr and admin: everything below
  const links = nav.filter(([p]) => (pages ? pages.includes(p) : true)).filter(([p]) => p !== '/billing' || u.role === 'admin');
  const loc = useLocation(); const known = nav.some(([p]) => p === loc.pathname), ok = !known || links.some(([p]) => p === loc.pathname);   // a typed-in address of a page you may not open goes back to the dashboard
  return (<div className="min-h-screen lg:flex"><PrintHeader />
    {open && <div className="print:hidden fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
    <aside className={`print:hidden fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-gradient-to-b from-navy-950 to-navy-800 p-4 text-slate-200 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? '' : '-translate-x-full'}`}>
      <div className="mb-6 flex items-start gap-2"><div className="min-w-0 flex-1"><SidebarBrand /></div>
        <button className="mt-1 lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X /></button></div>
      <nav className="flex-1 space-y-1 overflow-y-auto">{links.map(([to, label, Icon]) => (
        <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${isActive ? 'bg-white/10 text-white shadow-inner ring-1 ring-white/10' : 'text-slate-300 hover:bg-white/5'}`}><Icon size={18} />{label}</NavLink>))}</nav>
      <button className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-navy-800" onClick={doLogout}><LogOut size={18} />Logout</button>
    </aside>
    <div className="min-w-0 flex-1">
      <header className="print:hidden sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur">
        <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu /></button>
        <Logo variant="icon" className="hidden h-8 w-auto shrink-0 min-[400px]:block lg:hidden" />
        <GlobalSearch />
        <div className="ml-auto flex items-center gap-4"><NotificationBell /><div className="text-right text-sm leading-tight"><div className="font-medium">{u.name}</div><div className="text-xs capitalize text-slate-500">{u.role}</div></div></div>
      </header>
      <main className="p-4 sm:p-6">{!ok ? <Navigate to="/" replace /> : <Routes><Route path="/" element={<Dashboard />} /><Route path="/employees" element={<Employees />} /><Route path="/attendance" element={<Attendance />} /><Route path="/timesheets" element={<Timesheets />} /><Route path="/rules" element={<RulesPage />} /><Route path="/training" element={<Training />} /><Route path="/performance" element={<Performance />} /><Route path="/ui-claims" element={<UiClaims />} /><Route path="/insurance" element={<Insurance />} /><Route path="/enrollment" element={<Enrollment />} /><Route path="/schedules" element={<Schedules />} /><Route path="/part-time" element={<PartTime />} /><Route path="/benefits-admin" element={<BenefitsAdmin />} /><Route path="/sick-admin" element={<SickAdmin />} />
        <Route path="/leave" element={<Leave />} /><Route path="/payroll" element={<Payroll />} /><Route path="/compensation" element={<Compensation />} /><Route path="/onboarding" element={<Onboarding />} /><Route path="/credentials" element={<Credentials />} /><Route path="/offboarding" element={<Offboarding />} /><Route path="/compliance" element={<Compliance />} /><Route path="/recruitment" element={<Recruitment />} /><Route path="/interviews" element={<MyInterviews />} />
        <Route path="/benefits" element={<Benefits />} /><Route path="/sick-leave" element={<SickLeave />} /><Route path="/reports" element={<Reports />} /><Route path="/billing" element={<Billing />} /><Route path="/assistant" element={<Assistant />} /><Route path="*" element={<Navigate to="/" />} /></Routes>}</main>
    </div></div>);
}

export default function App() {
  const [state, setState] = useState<'loading' | 'in' | 'out' | 'change'>('loading');
  const careers = window.location.pathname.startsWith('/careers'), invite = window.location.pathname.startsWith('/accept-invite');   // public pages
  const check = () => loadMe().then((r) => setState(r.pending ? 'change' : 'in')).catch(() => { localStorage.clear(); setState('out'); });
  useEffect(() => { if (!careers && !invite) check(); }, []);
  if (invite) return <AcceptInvite />;
  if (careers) return <BrowserRouter><Careers /></BrowserRouter>;
  if (state === 'loading') return <div className="grid min-h-screen place-items-center text-sm text-slate-500">Loading…</div>;
  if (state === 'change') return <ForceChangePassword onDone={check} />;
  if (state === 'out') return <Login onDone={check} />;
  return user()?.role === 'superadmin' ? <PlatformShell /> : <BrowserRouter><Shell /></BrowserRouter>;
}
