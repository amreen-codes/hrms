/** Account rules: password policy and which roles an actor may assign. Pure: no DB, no clock. */
export const MIN_PW = 12;
export const MAX_PW_BYTES = 72;                       // bcrypt only uses the first 72 bytes: refuse longer input instead of silently truncating it
/** Company roles. `superadmin` is a platform role: it is never created or assigned through company user management. */
export const COMPANY_ROLES = ['admin', 'hr', 'manager', 'employee'] as const;
export type CompanyRole = typeof COMPANY_ROLES[number];

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(pw: unknown, email?: string): string | null {
  if (typeof pw !== 'string' || !pw.trim()) return 'Password is required';
  if (pw.length < MIN_PW) return `Password must be at least ${MIN_PW} characters`;
  if (Buffer.byteLength(pw, 'utf8') > MAX_PW_BYTES) return `Password must be at most ${MAX_PW_BYTES} bytes`;
  if (email && pw.toLowerCase() === email.trim().toLowerCase()) return 'Password must not be the email address';
  return null;
}

/** Roles the actor may give to a NEW account. Admin: all four company roles. HR: employee and manager only (no lateral or upward grants). Everyone else: none. */
export function assignableRoles(actorRole: string): CompanyRole[] {
  if (actorRole === 'admin') return ['admin', 'hr', 'manager', 'employee'];
  if (actorRole === 'hr') return ['manager', 'employee'];
  return [];
}
export const canAssignRole = (actorRole: string, role: unknown): role is CompanyRole => (assignableRoles(actorRole) as string[]).includes(String(role));
/** Only an Admin may reset passwords. A superadmin account is never reset through company user management. */
export const canResetPassword = (actorRole: string, targetRole: string) => actorRole === 'admin' && targetRole !== 'superadmin';
