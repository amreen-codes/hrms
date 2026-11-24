import { describe, it, expect } from 'vitest';
import net from 'node:net';
import * as Mail from '../src/mailer';
function fake(opts: { reject?: string } = {}) {
  const got: { lines: string[]; data: string } = { lines: [], data: '' };
  const srv = net.createServer((s) => { let inData = false, buf = ''; s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\r\n')) >= 0 || (inData && buf.includes('\r\n.\r\n'))) {
      if (inData) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) break; got.data = buf.slice(0, e); buf = buf.slice(e + 5); inData = false; s.write('250 queued\r\n'); continue; }
      const line = buf.slice(0, i); buf = buf.slice(i + 2); got.lines.push(line);
      if (/^EHLO/.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n'); else if (/^AUTH/.test(line)) s.write('235 ok\r\n'); else if (/^MAIL/.test(line)) s.write('250 ok\r\n');
      else if (/^RCPT/.test(line)) s.write(opts.reject ? `550 ${opts.reject}\r\n` : '250 ok\r\n'); else if (/^DATA/.test(line)) { s.write('354 go\r\n'); inData = true; } else if (/^QUIT/.test(line)) { s.write('221 bye\r\n'); s.end(); } } }); });
  return new Promise<{ port: number; got: typeof got; close: () => void }>((ok) => srv.listen(0, '127.0.0.1', () => ok({ port: (srv.address() as net.AddressInfo).port, got, close: () => srv.close() })));
}
const cfg = (port: number): Mail.SmtpConfig => ({ host: '127.0.0.1', port, secure: false, from: 'hr@ams.test', user: 'u', pass: 'p', allowPlain: true });
describe('SMTP (local fake server, plain path only)', () => {
  it('delivers: EHLO, AUTH, MAIL, RCPT, DATA in order; message is base64 UTF-8', async () => {
    const f = await fake(); await Mail.sendSmtp(cfg(f.port), { to: 'ali@ams.test', subject: 'Welcome Zoë', text: 'Hello\n.\nBye' }); f.close();
    expect(f.got.lines.map((l) => l.split(' ')[0])).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    expect(f.got.lines[3]).toBe('RCPT TO:<ali@ams.test>'); expect(f.got.data).toContain('To: <ali@ams.test>');
    expect(Buffer.from(f.got.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString()).toBe('Hello\r\n.\r\nBye');
  });
  it('reports a rejected recipient', async () => { const f = await fake({ reject: 'no such user' }); let err = ''; try { await Mail.sendSmtp(cfg(f.port), { to: 'x@ams.test', subject: 's', text: 't' }); } catch (e: any) { err = e.message; } f.close(); expect(err).toContain('RCPT TO failed'); });
  it('refuses to send a password without TLS unless allowed', async () => { const f = await fake(); let err = ''; try { await Mail.sendSmtp({ ...cfg(f.port), allowPlain: false }, { to: 'a@ams.test', subject: 's', text: 't' }); } catch (e: any) { err = e.message; } f.close(); expect(err).toContain('clear text'); });
  it('blocks header injection and bad addresses', () => {
    expect(() => Mail.buildMessage({ from: 'a@b.co', to: 'c@d.co', subject: 'hi\r\nBcc: x@y.co', text: 't' })).toThrow();
    expect(() => Mail.buildMessage({ from: 'a@b.co', to: 'c@d.co\r\nBcc: x@y.co', text: 't', subject: 's' })).toThrow();
    expect(() => Mail.buildMessage({ from: 'a@b.co', to: 'not-an-email', subject: 's', text: 't' })).toThrow();
  });
  it('config from env needs host and from', () => { expect(Mail.cfgFromEnv({} as any)).toBeNull(); expect(Mail.cfgFromEnv({ SMTP_HOST: 'h', SMTP_FROM: 'a@b.co', SMTP_PORT: '465', SMTP_SECURE: 'true' } as any)?.port).toBe(465); });
});
