"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hr = exports.staff = exports.only = exports.bad = exports.wrap = void 0;
const services_1 = require("./services");
/** Shared route helpers (used by routes.ts and lifecycle.ts). */
const wrap = (f) => (q, s, n) => Promise.resolve(f(q, s)).catch(n);
exports.wrap = wrap;
const bad = (m, status = 400) => new services_1.HttpErr(status, m);
exports.bad = bad;
const only = (...roles) => (q, s, n) => (roles.includes(q.user.role) ? n() : s.status(403).json({ error: 'Not allowed for your role' }));
exports.only = only;
exports.staff = (0, exports.only)('admin', 'hr', 'manager');
exports.hr = (0, exports.only)('admin', 'hr');
