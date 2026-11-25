"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cfgFromEnv = void 0;
exports.buildMessage = buildMessage;
exports.sendSmtp = sendSmtp;
/** SMTP delivery without extra dependencies (implicit TLS, STARTTLS or plain for local relays). Headers are checked against CRLF injection. */
const node_net_1 = __importDefault(require("node:net"));
const node_tls_1 = __importDefault(require("node:tls"));
const cfgFromEnv = (e = process.env) => e.SMTP_HOST && e.SMTP_FROM ? { host: e.SMTP_HOST, port: Number(e.SMTP_PORT || 587), secure: e.SMTP_SECURE === 'true', user: e.SMTP_USER || undefined, pass: e.SMTP_PASS || undefined, from: e.SMTP_FROM, allowPlain: e.SMTP_ALLOW_PLAIN === 'true' } : null;
exports.cfgFromEnv = cfgFromEnv;
const EMAIL = /^[^\s<>()@,;:"]+@[^\s<>()@,;:"]+\.[^\s<>()@,;:"]+$/;
const clean = (v, what) => { if (/[\r\n]/.test(v))
    throw new Error(`${what} contains a line break`); return v.trim(); };
function buildMessage(a) {
    const from = clean(a.from, 'From'), to = clean(a.to, 'To');
    if (!EMAIL.test(from) || !EMAIL.test(to))
        throw new Error('Invalid email address');
    const subj = clean(a.subject, 'Subject'), body = Buffer.from(a.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    return [`From: <${from}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${Buffer.from(subj, 'utf8').toString('base64')}?=`, `Date: ${(a.date || new Date()).toUTCString()}`, `Message-ID: <${a.id || Date.now() + '.' + Math.random().toString(36).slice(2)}@${from.split('@')[1]}>`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
}
const dotStuff = (m) => m.replace(/(^|\r\n)\./g, '$1..');
function reader(sock) {
    let buf = '', waiter = null, err = null;
    const tryNow = () => {
        if (!waiter)
            return;
        const parts = buf.split('\r\n');
        const end = parts.findIndex((l, i) => i < parts.length - 1 && /^\d{3} /.test(l));
        if (end < 0)
            return;
        const lines = parts.slice(0, end + 1);
        buf = parts.slice(end + 1).join('\r\n');
        const w = waiter;
        waiter = null;
        w.ok({ code: Number(lines[end].slice(0, 3)), lines });
    };
    sock.on('data', (d) => { buf += d.toString('utf8'); tryNow(); });
    sock.on('error', (e) => { err = e; if (waiter) {
        const w = waiter;
        waiter = null;
        w.fail(e);
    } });
    sock.setTimeout(15000, () => sock.destroy(new Error('SMTP timeout')));
    return { read: () => new Promise((ok, fail) => { if (err)
            return fail(err); waiter = { ok, fail }; tryNow(); }) };
}
async function sendSmtp(cfg, m) {
    const raw = buildMessage({ from: cfg.from, ...m });
    let sock = cfg.secure ? node_tls_1.default.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : node_net_1.default.connect({ host: cfg.host, port: cfg.port });
    let rd = reader(sock);
    const expect = async (codes, what) => { const r = await rd.read(); if (!codes.includes(r.code))
        throw new Error(`SMTP ${what} failed: ${r.lines[r.lines.length - 1]}`); return r; };
    const send = async (line, codes, what) => { sock.write(line + '\r\n'); return expect(codes, what); };
    try {
        await expect([220], 'greeting');
        let ehlo = await send('EHLO ams-hrms', [250], 'EHLO');
        if (!cfg.secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
            await send('STARTTLS', [220], 'STARTTLS');
            sock.removeAllListeners('data');
            sock = node_tls_1.default.connect({ socket: sock, servername: cfg.host });
            rd = reader(sock);
            ehlo = await send('EHLO ams-hrms', [250], 'EHLO');
        }
        else if (!cfg.secure && !cfg.allowPlain && cfg.user)
            throw new Error('Server does not offer STARTTLS: refusing to send the password in clear text');
        if (cfg.user)
            await send('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64'), [235], 'AUTH');
        await send(`MAIL FROM:<${cfg.from}>`, [250], 'MAIL FROM');
        await send(`RCPT TO:<${m.to.trim()}>`, [250, 251], 'RCPT TO');
        await send('DATA', [354], 'DATA');
        await send(dotStuff(raw) + '\r\n.', [250], 'message');
        sock.write('QUIT\r\n');
        await rd.read().catch(() => null); // the message is already accepted; QUIT is courtesy
    }
    finally {
        sock.destroy();
    }
}
