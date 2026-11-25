"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canResetPassword = exports.canAssignRole = exports.COMPANY_ROLES = exports.MAX_PW_BYTES = exports.MIN_PW = void 0;
exports.passwordProblem = passwordProblem;
exports.assignableRoles = assignableRoles;
/** Account rules: password policy and which roles an actor may assign. Pure: no DB, no clock. */
exports.MIN_PW = 12;
exports.MAX_PW_BYTES = 72; // bcrypt only uses the first 72 bytes: refuse longer input instead of silently truncating it
/** Company roles. `superadmin` is a platform role: it is never created or assigned through company user management. */
exports.COMPANY_ROLES = ['admin', 'hr', 'manager', 'employee'];
/** Returns a human-readable problem, or null when the password is acceptable. */
function passwordProblem(pw, email) {
    if (typeof pw !== 'string' || !pw.trim())
        return 'Password is required';
    if (pw.length < exports.MIN_PW)
        return `Password must be at least ${exports.MIN_PW} characters`;
    if (Buffer.byteLength(pw, 'utf8') > exports.MAX_PW_BYTES)
        return `Password must be at most ${exports.MAX_PW_BYTES} bytes`;
    if (email && pw.toLowerCase() === email.trim().toLowerCase())
        return 'Password must not be the email address';
    return null;
}
/** Roles the actor may give to a NEW account. Admin: all four company roles. HR: employee and manager only (no lateral or upward grants). Everyone else: none. */
function assignableRoles(actorRole) {
    if (actorRole === 'admin')
        return ['admin', 'hr', 'manager', 'employee'];
    if (actorRole === 'hr')
        return ['manager', 'employee'];
    return [];
}
const canAssignRole = (actorRole, role) => assignableRoles(actorRole).includes(String(role));
exports.canAssignRole = canAssignRole;
/** Only an Admin may reset passwords. A superadmin account is never reset through company user management. */
const canResetPassword = (actorRole, targetRole) => actorRole === 'admin' && targetRole !== 'superadmin';
exports.canResetPassword = canResetPassword;
