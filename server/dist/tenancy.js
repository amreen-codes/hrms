"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSystem = exports.runAs = exports.currentCtx = exports.als = void 0;
exports.setTestDefaultTenant = setTestDefaultTenant;
/** Request-scoped company context (P14: "scope all requests to company_id"). Every query on a tenant model is filtered by it in models.ts hooks. */
const node_async_hooks_1 = require("node:async_hooks");
exports.als = new node_async_hooks_1.AsyncLocalStorage();
let testDefault;
/** Tests only: lets direct model calls run inside a company without wrapping each one. Never available in production. */
function setTestDefaultTenant(id) {
    if (process.env.NODE_ENV === 'production')
        throw new Error('setTestDefaultTenant is not available in production');
    testDefault = id;
}
const currentCtx = () => exports.als.getStore() ?? (testDefault === undefined ? undefined : testDefault === null ? { platform: true } : { companyId: testDefault });
exports.currentCtx = currentCtx;
/** Run inside one company: all tenant queries are filtered and all inserts stamped with it. */
const runAs = (companyId, fn) => exports.als.run({ companyId }, fn);
exports.runAs = runAs;
/** System / platform code (login lookup, super admin console, schedulers): unscoped. Use sparingly and explicitly. */
const runSystem = (fn) => exports.als.run({ platform: true }, fn);
exports.runSystem = runSystem;
