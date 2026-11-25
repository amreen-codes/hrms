"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.forEachCompany = void 0;
exports.runScheduledJobs = runScheduledJobs;
exports.startJobs = startJobs;
/** Scheduled jobs run once PER COMPANY so notifications and escalations never cross tenants. */
const sequelize_1 = require("sequelize");
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
const lifecycle_1 = require("./lifecycle");
const compensation_1 = require("./compensation");
const uiInsurance_1 = require("./uiInsurance");
const training_1 = require("./training");
const complianceFlow_1 = require("./complianceFlow");
const billing_1 = require("./billing");
const ai_1 = require("./ai");
const forEachCompany = async (fn) => {
    const cs = await (0, tenancy_1.runSystem)(() => M.Company.findAll({ where: { status: 'active' } }));
    const out = [];
    for (const c of cs) {
        try {
            out.push({ companyId: c.id, ...(await (0, tenancy_1.runAs)(c.id, () => fn(c))) });
        }
        catch (e) {
            console.error(`job failed for company ${c.id}:`, e?.message);
        }
    }
    return out;
};
exports.forEachCompany = forEachCompany;
async function runScheduledJobs() {
    const perCompany = await (0, exports.forEachCompany)(async () => { await (0, compensation_1.applyDuePayChanges)(); return { lifecycle: await (0, lifecycle_1.sweepLifecycle)(), credentials: await (0, lifecycle_1.runCredentialReminders)(), ui: await (0, uiInsurance_1.runUiJob)(), insurance: await (0, uiInsurance_1.runInsuranceJob)(), training: await (0, training_1.runTrainingJob)(), compliance: await (0, complianceFlow_1.runComplianceJob)() }; });
    await (0, billing_1.expireGracePeriods)();
    await (0, tenancy_1.runSystem)(() => (0, ai_1.purgeOldChats)());
    await (0, tenancy_1.runSystem)(() => M.Session.destroy({ where: { expiresAt: { [sequelize_1.Op.lt]: new Date(Date.now() - 30 * 864e5) } } })); // housekeeping
    return perCompany;
}
function startJobs() {
    if (process.env.NODE_ENV === 'test')
        return;
    const tick = () => runScheduledJobs().catch((e) => console.error('scheduled jobs failed:', e?.message));
    tick();
    setInterval(tick, 6 * 36e5).unref();
}
