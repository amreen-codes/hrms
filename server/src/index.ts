import 'dotenv/config';
import { sequelize } from './models';
import { buildApp } from './app';
import { startJobs } from './jobs';
import { defaultRing } from './lifecycleCore';
// Tables are created if missing. Use `npm run migrate` for existing databases (DB_SYNC_ALTER=true is development only).
sequelize.sync({ alter: process.env.DB_SYNC_ALTER === 'true' && process.env.NODE_ENV !== 'production' })
  .then(() => {
    try { defaultRing(); } catch (e: any) { console.warn('WARNING: ' + e.message + '. I-9 / W-4 submission is disabled until it is set.'); }
    buildApp().listen(+(process.env.PORT || 4000), () => console.log('AMS API on :' + (process.env.PORT || 4000)));
    startJobs();        // per-company: P5 overdue escalation, P8 access revocation, P7 credential reminders, P17 due pay changes (every 6 h)
  });
