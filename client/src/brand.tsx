import { user } from './api';

/** One place for the HRMS logo. Files live in /public so they are served from the site root. */
export const LOGO_FULL = '/logo.png';
export const LOGO_ICON = '/logo-icon.png';

export function Logo({ variant = 'full', className = '', alt = 'HRMS' }: { variant?: 'full' | 'icon'; className?: string; alt?: string }) {
  return <img src={variant === 'full' ? LOGO_FULL : LOGO_ICON} alt={alt} className={className} draggable={false} />;
}

/** Sidebar brand: transparent icon, white wordmark, and a blue sparkle matching the login branding. */
export function SidebarBrand() {
  return (
    <div className="flex flex-col items-center py-3">
      <div className="flex items-center justify-center gap-2">
        <Logo variant="icon" className="h-11 w-11 flex-none object-contain" />
        <div className="relative flex items-center pr-1 pt-1">
          <span className="text-2xl font-extrabold tracking-wide text-white">HRMS</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="pointer-events-none absolute -right-2 -top-3 h-5 w-5 text-sky-300 drop-shadow-[0_0_5px_rgba(56,189,248,0.95)]"
            fill="currentColor"
          >
            <path d="M12 0.8 14.1 9.9 23.2 12l-9.1 2.1L12 23.2l-2.1-9.1L0.8 12l9.1-2.1L12 0.8Z" />
          </svg>
        </div>
      </div>
      <div className="mt-1 text-[10px] font-semibold tracking-[0.4em] text-blue-300">2026</div>
    </div>
  );
}

/** Shown only when printing / saving as PDF. Fixed elements repeat on every printed page, so the header appears at the top of each one. */
export function PrintHeader() {
  const u = user();
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="print-header hidden items-center justify-between border-b border-slate-300 pb-2">
      <Logo className="h-12 w-auto" />
      <div className="text-right text-xs leading-tight text-slate-600">
        <div className="text-sm font-semibold text-slate-900">{u?.companyName || 'HRMS'}</div>
        <div>{today}</div>
      </div>
    </div>
  );
}
