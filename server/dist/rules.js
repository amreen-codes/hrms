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
exports.rulesRouter = void 0;
/** S8: versioned compliance rules by jurisdiction + effective date. Never edited in place: a change is a new version (audit trail). */
const express_1 = require("express");
const M = __importStar(require("./models"));
const services_1 = require("./services");
const http_1 = require("./http");
const H = __importStar(require("./hrCore"));
const lifecycleCore_1 = require("./lifecycleCore");
exports.rulesRouter = (0, express_1.Router)();
const KEY = /^[a-z][a-z_]{2,39}$/, JUR = /^(US|[A-Z]{2}(:[A-Za-z .'-]{2,40})?)$/; // US, CA, or CA:Los Angeles
function validateValue(key, v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw (0, http_1.bad)('value must be an object');
    if (key === 'final_pay') {
        if (typeof v.payoutAccruedLeave !== 'boolean' || typeof v.payoutSick !== 'boolean')
            throw (0, http_1.bad)('final_pay needs payoutAccruedLeave and payoutSick (true/false)');
        if (typeof v.deadline !== 'string' || !v.deadline.trim() || v.deadline.length > 300)
            throw (0, http_1.bad)('final_pay needs a deadline description (max 300 characters)');
    }
    if (key.startsWith('task_')) {
        if (typeof v.type !== 'string' || !v.type.trim() || v.type.length > 120)
            throw (0, http_1.bad)('A task rule needs a type (the task name, max 120 characters)');
        if (!['hire', 'annual'].includes(v.trigger))
            throw (0, http_1.bad)('trigger must be hire or annual (training and credential tasks come from their own modules)');
        if (!Number.isInteger(v.dueDays) || v.dueDays < 1 || v.dueDays > 365)
            throw (0, http_1.bad)('dueDays must be a whole number from 1 to 365');
        if (v.retentionYears !== undefined && !(Number.isInteger(v.retentionYears) && v.retentionYears >= 0 && v.retentionYears <= 99))
            throw (0, http_1.bad)('retentionYears must be 0 to 99');
    }
    if (JSON.stringify(v).length > 5000)
        throw (0, http_1.bad)('value is too large');
}
exports.rulesRouter.get('/compliance-rules', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const where = {};
    if (q.query.key)
        where.key = String(q.query.key);
    if (q.query.jurisdiction)
        where.jurisdiction = String(q.query.jurisdiction);
    s.json(await M.ComplianceRule.findAll({ where, order: [['key', 'ASC'], ['jurisdiction', 'ASC'], ['version', 'DESC']], limit: 500 }));
}));
exports.rulesRouter.get('/compliance-rules/effective', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const key = String(q.query.key || ''), date = (0, lifecycleCore_1.isoDate)(String(q.query.date || '')) || new Date().toISOString().slice(0, 10);
    const js = String(q.query.jurisdictions || 'US').split(',').map((x) => x.trim()).filter(Boolean);
    if (!KEY.test(key))
        throw (0, http_1.bad)('key is required');
    s.json(H.ruleAt((await M.ComplianceRule.findAll({ where: { key }, raw: true })), key, js, date)); // first jurisdiction wins (put the most specific first)
}));
exports.rulesRouter.post('/compliance-rules', http_1.hr, (0, http_1.wrap)(async (q, s) => {
    const b = q.body, key = String(b.key || ''), jurisdiction = String(b.jurisdiction || ''), eff = (0, lifecycleCore_1.isoDate)(b.effectiveDate);
    if (!KEY.test(key))
        throw (0, http_1.bad)('key must be lowercase letters and underscores');
    if (!JUR.test(jurisdiction))
        throw (0, http_1.bad)('jurisdiction must look like US, CA or CA:Los Angeles');
    if (!eff)
        throw (0, http_1.bad)('Enter a valid effective date');
    validateValue(key, b.value);
    const last = await M.ComplianceRule.findOne({ where: { key, jurisdiction }, order: [['version', 'DESC']] });
    const r = await M.ComplianceRule.create({ key, jurisdiction, effectiveDate: eff, version: (last?.version || 0) + 1, value: b.value, sourceUrl: String(b.sourceUrl || '').slice(0, 500), legalOwner: String(b.legalOwner || '').slice(0, 120), verified: !!b.verified, createdBy: q.user.id });
    await (0, services_1.log)(q.user.id, 'Compliance Rule Added', `${key} ${jurisdiction} v${r.version} effective ${eff}`);
    s.status(201).json(r);
}));
