import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import routes from './routes';
import { HttpErr } from './services';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { checkResume } from './resumeCore';
import { stripeWebhook } from './billing';
import { installNotificationMailer } from './mail';
import { sequelize } from './models';

export const UPLOAD_DIR = () => process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'resumes');
export const RESUME_REF = /^file:[a-f0-9]{32}\.(pdf|docx|doc)$/;

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);   // behind nginx: real client IP for rate limits and security events
  installNotificationMailer();
  app.use(helmet());
  app.get('/api/health', (_q, s) => { sequelize.authenticate().then(() => s.json({ ok: true })).catch(() => s.status(503).json({ ok: false })); });   // for uptime monitors / load balancers: no data, no version
  app.use(cors({ origin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(','), credentials: true }));   // cookie sessions need credentials
  // Resume upload: public (applicants have no login), rate limited, own 8 MB JSON limit, validated by file bytes.
  const upLimiter = process.env.NODE_ENV === 'test' ? (_q: any, _s: any, n: any) => n() : rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  app.post('/api/public/resume', upLimiter, express.json({ limit: '8mb' }), (q, s) => {
    try {
      const bytes = Buffer.from(String(q.body?.data || ''), 'base64'), r = checkResume(String(q.body?.fileName || ''), bytes);
      if (r.ok === false) return s.status(400).json({ error: r.error });
      fs.mkdirSync(UPLOAD_DIR(), { recursive: true }); fs.writeFileSync(path.join(UPLOAD_DIR(), r.storedName), bytes, { flag: 'wx' });
      s.json({ ref: 'file:' + r.storedName, name: r.original });
    } catch { s.status(500).json({ error: 'Upload failed' }); }
  });
  app.post('/api/webhooks/stripe', ...stripeWebhook);                 // raw body: must come before express.json()
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', routes);
  app.use((e: any, _q: any, s: any, _n: any) => {
    if (e instanceof HttpErr) return s.status(e.status).json({ error: e.message });
    console.error(e?.message); s.status(500).json({ error: 'Server error' });   // never leak internals
  });
  return app;
}
