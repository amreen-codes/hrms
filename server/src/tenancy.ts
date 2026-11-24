/** Request-scoped company context (P14: "scope all requests to company_id"). Every query on a tenant model is filtered by it in models.ts hooks. */
import { AsyncLocalStorage } from 'node:async_hooks';
export interface Ctx { companyId?: number | null; platform?: boolean }
export const als = new AsyncLocalStorage<Ctx>();
let testDefault: number | null | undefined;
/** Tests only: lets direct model calls run inside a company without wrapping each one. Never available in production. */
export function setTestDefaultTenant(id: number | null | undefined) {
  if (process.env.NODE_ENV === 'production') throw new Error('setTestDefaultTenant is not available in production');
  testDefault = id;
}
export const currentCtx = (): Ctx | undefined => als.getStore() ?? (testDefault === undefined ? undefined : testDefault === null ? { platform: true } : { companyId: testDefault });
/** Run inside one company: all tenant queries are filtered and all inserts stamped with it. */
export const runAs = <T>(companyId: number, fn: () => Promise<T>): Promise<T> => als.run({ companyId }, fn);
/** System / platform code (login lookup, super admin console, schedulers): unscoped. Use sparingly and explicitly. */
export const runSystem = <T>(fn: () => Promise<T>): Promise<T> => als.run({ platform: true }, fn);
