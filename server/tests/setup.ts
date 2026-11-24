// Safety: the tests DROP and recreate every table. They only run against a database whose name contains "test".
if (!/test/i.test(String(process.env.DB_NAME))) throw new Error(`Refusing to run tests against database "${process.env.DB_NAME}": its name must contain "test"`);
// Legacy single-company tests: every direct model call runs in company 1, and sync() always leaves company 1 in place.
// Multi-company tests call setTestDefaultTenant(undefined) and use runAs() / HTTP explicitly.
import { setTestDefaultTenant } from '../src/tenancy';
import * as M from '../src/models';
setTestDefaultTenant(1);
M.sequelize.addHook('afterBulkSync', async () => { if (!(await M.Company.count())) await M.Company.create({ id: 1, name: 'Test Co', slug: 'test', plan: 'enterprise', subState: 'active' } as any); });
