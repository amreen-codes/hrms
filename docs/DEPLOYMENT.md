# AMS HRMS: Deployment Guide

Written for a single Ubuntu VPS (22.04 or 24.04) with one domain. Every command is meant to be copied as is; replace `hrms.example.com` with your domain. Budget about 2 to 3 hours the first time.

> **Status of this guide.** The application was built, migrated and started in production mode (`NODE_ENV=production`) and its 338 automated tests pass, all on **MariaDB 10.11**. It has **not** been run on a real server, against live Stripe, a real SMTP provider or a real OpenAI account (those were simulated in tests). Section 15 tells you how to prove each of them before real customers use the system. If you choose **MySQL 8**, run the automated tests against it once (section 4) before go-live.

---

## 0. What you need before you start

| Item | Notes |
|---|---|
| Domain name | One name for everything, e.g. `hrms.example.com`. DNS "A" record pointing to the server IP. |
| VPS | 2 vCPU, 2 GB RAM, 40 GB disk is enough to start. Ubuntu 22.04 / 24.04. |
| SMTP account | Any transactional mail provider (Postmark, SendGrid, Amazon SES, Brevo, Mailgun, or your company mail). You need host, port, user, password and a "from" address on a domain you own. |
| Stripe account | Only if you charge customers online. Start in **test mode**. |
| OpenAI API key | Only for the AI assistant. Set a monthly spending limit in the OpenAI dashboard. |
| A password manager | For the database password, the encryption key and the super admin password. |

**Why one domain.** The login cookie is `HttpOnly`, `Secure` and `SameSite=Lax`. If the web page and the API live on one domain (nginx serves the web app and forwards `/api` to the API) there is nothing to configure for cross-site cookies or CORS. Do not split them across different domains.

## 1. Architecture

```
Browser --HTTPS--> nginx (443)
                     |-- /            static web app  (/var/www/ams/client)
                     |-- /api/...     proxy -> Node API on 127.0.0.1:4000
                                           |-- MySQL / MariaDB (localhost only)
                                           |-- uploads folder  (/var/lib/ams/uploads)
Node API --> Stripe, SMTP server, OpenAI (outbound HTTPS / SMTP only)
Stripe   --> https://hrms.example.com/api/webhooks/stripe  (inbound, signed)
```

## 2. Prepare the server

```bash
ssh root@YOUR_SERVER_IP
apt update && apt -y upgrade
adduser --disabled-password --gecos "" ams            # the app runs as this user, never as root
usermod -aG sudo ams                                  # optional: for your own admin work
apt -y install nginx ufw git curl unzip certbot python3-certbot-nginx fail2ban
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

Node.js 22 (LTS) from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node -v      # v22.x
```

## 3. Database

MySQL 8 (or MariaDB 10.11+):

```bash
apt -y install mysql-server            # or: apt -y install mariadb-server
mysql_secure_installation              # answer yes to the hardening questions
```

Create the database and a **limited** user (never use `root` for the app). Generate the password first with `openssl rand -base64 24` and keep it in your password manager.

```bash
mysql -u root -p <<'SQL'
CREATE DATABASE ams_hrms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ams'@'127.0.0.1' IDENTIFIED BY 'PUT_THE_GENERATED_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON ams_hrms.* TO 'ams'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
```

The database must listen on localhost only (the default). Do **not** open port 3306 in the firewall.

## 4. Get the code and build it

Upload the project zip to the server (for example `scp ams-hrms.zip ams@YOUR_SERVER_IP:~`), then:

```bash
sudo -iu ams
mkdir -p ~/app && cd ~/app && unzip ~/ams-hrms.zip && cd ams-hrms

# API
cd server && npm ci && npm run build            # creates server/dist
# Web app: the API address is baked in at build time. Same domain, so /api:
cd ../client && npm ci && VITE_API=/api npm run build    # creates client/dist

# Publish the web files for nginx
sudo mkdir -p /var/www/ams && sudo rm -rf /var/www/ams/client && sudo cp -r dist /var/www/ams/client
```

**Optional but recommended before go-live (MySQL users):** run the automated tests once on that database. Create an empty test database and user, then:

```bash
cd ~/app/ams-hrms/server
# The tests DROP and recreate every table. Use a SEPARATE database whose name contains "test"
# (the test runner refuses any other name). Create it first: CREATE DATABASE ams_hrms_test; and grant the user on it.
TEST_DB_NAME=ams_hrms_test TEST_DB_USER=ams TEST_DB_PASS='the-db-password' npm test      # expect: 23 test files, 338 tests pass
```

## 5. Configuration (`server/.env`)

```bash
sudo mkdir -p /var/lib/ams/uploads && sudo chown -R ams:ams /var/lib/ams
cd ~/app/ams-hrms/server && cp .env.example .env && chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # use this output as DATA_ENCRYPTION_KEY
nano .env
```

Set at least these (everything else can stay as in the example):

```ini
NODE_ENV=production
PORT=4000
APP_URL=https://hrms.example.com
CLIENT_ORIGIN=https://hrms.example.com
TRUST_PROXY=1

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ams_hrms
DB_USER=ams
DB_PASS=PUT_THE_GENERATED_PASSWORD_HERE

DATA_ENCRYPTION_KEY=PASTE_THE_BASE64_KEY
UPLOAD_DIR=/var/lib/ams/uploads

# optional features: leave empty to switch them off
SMTP_HOST=...        SMTP_PORT=587     SMTP_SECURE=false
SMTP_USER=...        SMTP_PASS=...     SMTP_FROM=noreply@example.com
NOTIFY_EMAIL=false
STRIPE_SECRET_KEY=sk_test_...          STRIPE_WEBHOOK_SECRET=whsec_...
OPENAI_API_KEY=sk-...                  OPENAI_MODEL=gpt-4o-mini
```

Rules that matter:

* **`DATA_ENCRYPTION_KEY` protects the I-9 / W-4 data. If it is lost, that data can never be read again.** Store a copy in your password manager and one offline. Never commit `.env` to git.
* `ALLOW_BEARER` must **not** be set in production (it is ignored there anyway).
* **Never run `npm run seed` in production.** It creates demo users with a known password.
* `NOTIFY_EMAIL=true` e-mails only the *title* of a notification, never its text, because notifications can contain sensitive HR detail.
* Choose the OpenAI model your account can use. `OPENAI_MODEL` is not validated by the app; a wrong name shows up as "AI service is not available" and an error in the log.

## 6. First start: migrate, create the platform owner

```bash
cd ~/app/ams-hrms/server
npm run migrate:prod                                   # creates / upgrades all tables (safe to repeat)
npm run create-superadmin:prod -- owner@example.com 'A-Long-Unique-Passphrase-2026!'
```

The super admin is the platform owner: it creates companies and invites each company's first Admin by e-mail. It cannot see company data. Use a password of 12+ characters that you use nowhere else.

## 7. Run the API as a service (systemd)

`/etc/systemd/system/ams-api.service` (create with `sudo nano`):

```ini
[Unit]
Description=AMS HRMS API
After=network.target mysql.service
Wants=mysql.service

[Service]
User=ams
WorkingDirectory=/home/ams/app/ams-hrms/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
# basic sandboxing
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/ams

[Install]
WantedBy=multi-user.target
```

If the database is MariaDB, replace `mysql.service` with `mariadb.service`. The app reads `.env` from its working directory.

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ams-api
sudo systemctl status ams-api --no-pager        # active (running)
curl -s http://127.0.0.1:4000/api/health        # {"ok":true}
journalctl -u ams-api -n 50 --no-pager          # logs
```

## 8. nginx and HTTPS

`/etc/nginx/sites-available/ams`:

```nginx
server {
    listen 80;
    server_name hrms.example.com;
    root /var/www/ams/client;
    index index.html;

    client_max_body_size 10m;                      # resume uploads are up to 8 MB

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;                    # AI answers can take a while
    }
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location / { try_files $uri /index.html; }     # single-page app routes
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ams /etc/nginx/sites-enabled/ams
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d hrms.example.com            # free TLS certificate, auto-renewing, adds the HTTPS block and redirect
```

Open `https://hrms.example.com`: the login page must load with a padlock. Sign in with the super admin and create your first company.

## 9. E-mail (invitations, candidate messages, alerts)

1. Create the sending domain at your mail provider and add the **SPF** and **DKIM** DNS records it gives you. Add a **DMARC** record (`v=DMARC1; p=none; rua=mailto:you@example.com` to start). Without these, mail lands in spam.
2. Put the SMTP settings in `.env`, then `sudo systemctl restart ams-api`.
3. Test: as super admin create a company with an admin e-mail you control. The page says whether the invitation was e-mailed; the link is also shown once, so you are never locked out if mail fails.
4. Delivery attempts (sent / failed / skipped) are stored in the `EmailLogs` table (no message text, no passwords).

The app never e-mails passwords. Admin-created accounts get a password typed by the admin and communicated outside the system; the user must change it at first login.

## 10. Stripe billing

Use **test mode** until section 15 passes.

1. **API key:** Stripe Dashboard -> Developers -> API keys -> secret key (`sk_test_...`) into `STRIPE_SECRET_KEY`.
2. **Webhook:** Developers -> Webhooks -> Add endpoint:
   * URL: `https://hrms.example.com/api/webhooks/stripe`
   * Events: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`
   * Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`. Restart the API.
3. **Customer portal** (Settings -> Billing -> Customer portal): enable payment-method updates, invoice history and cancellation (set "cancel at end of billing period"). To allow **plan changes** in the portal, create three monthly recurring prices in Stripe (Starter **$79**, Growth **$149**, Professional **$299**, USD) and add them under "Subscriptions -> customers can switch plans". The app recognises a plan change by its monthly amount; if you change a price in `platformCore.ts` change it in Stripe too.
4. How it behaves: an Admin opens **Billing**, picks a plan and is sent to Stripe Checkout. The webhook activates the plan. A failed payment puts the company in **past due** for 7 days, then **read-only** (people can still read, log in and open Billing to pay; writes are refused). A successful payment restores full access. Cancelling in the portal moves to "cancels at period end", then **cancelled**. Enterprise has no list price and is set by the super admin.
5. Test with Stripe test cards (`4242 4242 4242 4242` succeeds; `4000 0000 0000 0341` attaches but fails the next charge). Locally you can forward events with the Stripe CLI: `stripe listen --forward-to localhost:4000/api/webhooks/stripe`.
6. **Going live:** switch the dashboard to live mode, create the live webhook endpoint, replace both keys, restart. Live and test keys must never be mixed.

Webhooks are verified (signature + 5 minute tolerance) and processed once per event id, so Stripe retries are safe. Failed processing returns 500 and Stripe retries automatically.

## 11. AI assistant (OpenAI)

* Set `OPENAI_API_KEY` and `OPENAI_MODEL`. Without a key the assistant politely says it is not configured.
* **What it can do:** answer questions; read data the signed-in person is allowed to see (own leave balance; team headcount, pending leave and people search for managers/HR/admin; compliance tasks). It can **propose** a leave request or a leave approval/rejection. Nothing is changed until the same person presses **Confirm**; the action is then checked again with the normal permission rules and expires after 15 minutes. Everything (prompts, tool calls, proposals, confirmations) is recorded; admins read it at `GET /api/ai/audit`.
* **Privacy.** The text people type and the data the tools return (names, leave dates, counts) are sent to OpenAI. SSNs, bank data, pay and personal documents are not exposed to the assistant. Tell your staff, mention OpenAI in your privacy notice, and review your OpenAI data-retention settings.
* Rate limit: 20 requests per minute per person. Set a monthly budget in the OpenAI dashboard.

## 12. Backups (do this before real data goes in)

1. **Database**, nightly, kept 14 days. As user `ams`, create `/home/ams/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail
D=/var/backups/ams; mkdir -p $D
export MYSQL_PWD="$(grep ^DB_PASS /home/ams/app/ams-hrms/server/.env | cut -d= -f2-)"
mysqldump --single-transaction --no-tablespaces -h127.0.0.1 -uams ams_hrms | gzip > $D/db-$(date +%F).sql.gz
tar czf $D/uploads-$(date +%F).tgz -C /var/lib/ams uploads
find $D -type f -mtime +14 -delete
```

   `chmod 700 backup.sh`, then `sudo mkdir -p /var/backups/ams && sudo chown ams /var/backups/ams` and add to `crontab -e`: `30 2 * * * /home/ams/backup.sh`.
2. **Copy the backups off the server** (another provider or object storage). A backup on the same disk is not a backup.
3. **Keep `DATA_ENCRYPTION_KEY` and `.env` in your password manager.** The database dump alone cannot restore I-9 / W-4 data without the key.
4. **Test a restore** into a scratch database now and every quarter: `gunzip -c db-YYYY-MM-DD.sql.gz | mysql -uams -p ams_restore_test`, then start a copy of the app against it.

## 13. Updating and rolling back

```bash
sudo -iu ams && cd ~/app
/home/ams/backup.sh                                   # always back up first
cp -r ams-hrms ams-hrms.previous                      # keep the old version for rollback
# unzip the new version over ams-hrms (keep server/.env), then:
cd ams-hrms/server && npm ci && npm run build && npm run migrate:prod
cd ../client && npm ci && VITE_API=/api npm run build && sudo rm -rf /var/www/ams/client && sudo cp -r dist /var/www/ams/client
sudo systemctl restart ams-api && curl -s http://127.0.0.1:4000/api/health
```

Migrations only add things and are safe to repeat. To roll back: restore the previous folder, restore the database backup taken before the update, restart the service. Always read the release notes in `README.md` first.

## 14. Security checklist

- [ ] HTTPS only, certificate auto-renews (`sudo certbot renew --dry-run`).
- [ ] `ufw status`: only 22, 80, 443 open. MySQL not reachable from outside (`ss -ltnp | grep 3306` shows 127.0.0.1).
- [ ] SSH: key login only, root login disabled (`PermitRootLogin no`, `PasswordAuthentication no` in `/etc/ssh/sshd_config`), `fail2ban` active.
- [ ] `.env` is `chmod 600`, owned by `ams`, not in git or in any backup that leaves your control unencrypted.
- [ ] Strong unique passwords for the super admin and every Admin. There is no MFA by design (requirement); lockout after 5 wrong passwords for 15 minutes, 15 minute idle timeout and 8 hour session limit are active.
- [ ] Unattended security updates: `apt -y install unattended-upgrades`.
- [ ] Stripe webhook secret and API keys are the live ones, and only on the server.
- [ ] You know who can read the audit log (Admins) and the AI audit (Admins).

## 15. Proof tests before real customers (on your own server)

Work through `docs/TEST_CHECKLIST.md`, especially sections 2 (accounts), 8 (Stripe, test mode), 9 (e-mail), 10 (reports), 11 (AI) and 14 (backup restore). These are the parts the automated tests could only simulate.

## 16. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Login works but you are logged out immediately | Page not on HTTPS, or API and web on different domains. Use one HTTPS domain as described. |
| Every request says "Too many requests" for everyone | `TRUST_PROXY=1` missing, so all users share the proxy's IP. Set it and restart. |
| Blank page after login | Client built without `VITE_API=/api` (it points to localhost). Rebuild the client and re-copy `dist`. |
| `Cannot connect to database` in the log | Wrong `DB_*` values, MySQL not running, or the user was created for `localhost` instead of `127.0.0.1`. |
| `DATA_ENCRYPTION_KEY` warning at start | Key missing or not 32 bytes base64. I-9 / W-4 submission stays disabled until fixed. |
| Invitation says "not emailed" | SMTP not configured or rejected. Check `journalctl -u ams-api` and the `EmailLogs` table (`status`, `error`). Use the link shown on screen meanwhile. |
| Stripe webhook shows 400 "Invalid signature" | Wrong `STRIPE_WEBHOOK_SECRET` (test vs live, or another endpoint's secret), or a proxy that alters the body. |
| Payment succeeded but plan unchanged | Webhook not delivered. Stripe Dashboard -> Webhooks -> the endpoint -> recent deliveries; resend the failed event. |
| Company is read-only | Payment failed and the 7 day grace ended. Pay in Billing, or the super admin sets the state to active. |
| AI says "service is not available" | Wrong key / model name, no quota, or outbound HTTPS blocked. The log line `AI error:` says which. |
| 413 on resume upload | nginx `client_max_body_size` too small. |
| Reports download fails | Browser blocks the download, or the session expired. Sign in again. |

## 17. Go-live checklist

- [ ] Sections 2 to 12 complete; `docs/TEST_CHECKLIST.md` passed with the Stripe test keys.
- [ ] Backups run and one restore was tested.
- [ ] Live Stripe keys and live webhook in place, one real small payment tested and refunded.
- [ ] SMTP sending domain verified (SPF, DKIM, DMARC); invitation received in the inbox, not spam.
- [ ] First company created, its Admin signed in and created one user of each role.
- [ ] Legal items reviewed by your own counsel: privacy notice (mentions OpenAI and Stripe), terms, payroll and compliance rules the product shows (they are defaults to review, not legal advice).
- [ ] Someone owns monitoring: uptime check on `https://hrms.example.com/api/health`, disk space, certificate expiry, backup success.
