import 'dotenv/config';
import bcrypt from 'bcryptjs';
import * as M from './models';
import { runSystem } from './tenancy';
// usage: npm run create-superadmin -- owner@example.com 'a-long-password-12+'
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 12) { console.error('usage: create-superadmin <email> <password (12+ chars)>'); process.exit(1); }
runSystem(async () => {
  await M.sequelize.sync();
  if (await M.Employee.unscoped().findOne({ where: { email: email.toLowerCase() } })) throw new Error('That email already exists');
  await M.Employee.create({ name: 'Platform Owner', email: email.toLowerCase(), role: 'superadmin', status: 'active', companyId: null, password: bcrypt.hashSync(password, 12) } as any);
  console.log('Super admin created. Sign in with this email and password.');
}).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
