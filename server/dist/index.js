"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const models_1 = require("./models");
const app_1 = require("./app");
const jobs_1 = require("./jobs");
const lifecycleCore_1 = require("./lifecycleCore");
// Tables are created if missing. Use `npm run migrate` for existing databases (DB_SYNC_ALTER=true is development only).
models_1.sequelize.sync({ alter: process.env.DB_SYNC_ALTER === 'true' && process.env.NODE_ENV !== 'production' })
    .then(() => {
    try {
        (0, lifecycleCore_1.defaultRing)();
    }
    catch (e) {
        console.warn('WARNING: ' + e.message + '. I-9 / W-4 submission is disabled until it is set.');
    }
    (0, app_1.buildApp)().listen(+(process.env.PORT || 4000), () => console.log('AMS API on :' + (process.env.PORT || 4000)));
    (0, jobs_1.startJobs)(); // per-company: P5 overdue escalation, P8 access revocation, P7 credential reminders, P17 due pay changes (every 6 h)
});
