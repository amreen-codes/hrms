"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESUME_REF = exports.UPLOAD_DIR = void 0;
exports.buildApp = buildApp;
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const routes_1 = __importDefault(require("./routes"));
const services_1 = require("./services");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const resumeCore_1 = require("./resumeCore");
const billing_1 = require("./billing");
const mail_1 = require("./mail");
const models_1 = require("./models");
const UPLOAD_DIR = () => process.env.UPLOAD_DIR || node_path_1.default.join(process.cwd(), 'uploads', 'resumes');
exports.UPLOAD_DIR = UPLOAD_DIR;
exports.RESUME_REF = /^file:[a-f0-9]{32}\.(pdf|docx|doc)$/;
function buildApp() {
    const app = (0, express_1.default)();
    app.disable('x-powered-by');
    if (process.env.TRUST_PROXY)
        app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY); // behind nginx: real client IP for rate limits and security events
    (0, mail_1.installNotificationMailer)();
    app.use((0, helmet_1.default)());
    app.get('/api/health', (_q, s) => { models_1.sequelize.authenticate().then(() => s.json({ ok: true })).catch(() => s.status(503).json({ ok: false })); }); // for uptime monitors / load balancers: no data, no version
    app.use((0, cors_1.default)({ origin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(','), credentials: true })); // cookie sessions need credentials
    // Resume upload: public (applicants have no login), rate limited, own 8 MB JSON limit, validated by file bytes.
    const upLimiter = process.env.NODE_ENV === 'test' ? (_q, _s, n) => n() : (0, express_rate_limit_1.default)({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
    app.post('/api/public/resume', upLimiter, express_1.default.json({ limit: '8mb' }), (q, s) => {
        try {
            const bytes = Buffer.from(String(q.body?.data || ''), 'base64'), r = (0, resumeCore_1.checkResume)(String(q.body?.fileName || ''), bytes);
            if (r.ok === false)
                return s.status(400).json({ error: r.error });
            node_fs_1.default.mkdirSync((0, exports.UPLOAD_DIR)(), { recursive: true });
            node_fs_1.default.writeFileSync(node_path_1.default.join((0, exports.UPLOAD_DIR)(), r.storedName), bytes, { flag: 'wx' });
            s.json({ ref: 'file:' + r.storedName, name: r.original });
        }
        catch {
            s.status(500).json({ error: 'Upload failed' });
        }
    });
    app.post('/api/webhooks/stripe', ...billing_1.stripeWebhook); // raw body: must come before express.json()
    app.use(express_1.default.json({ limit: '100kb' }));
    app.use('/api', routes_1.default);
    app.use((e, _q, s, _n) => {
        if (e instanceof services_1.HttpErr)
            return s.status(e.status).json({ error: e.message });
        console.error(e?.message);
        s.status(500).json({ error: 'Server error' }); // never leak internals
    });
    return app;
}
