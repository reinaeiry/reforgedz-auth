# Deploying reforgedz-auth to the EU box

Target: `auth.reforgedz.net` served from a new Pterodactyl Node.js container on the EU box (`144.76.199.155`), fronted by the existing Cloudflare Tunnel.

Steps that can't be automated (need clicks in the Pterodactyl panel and Cloudflare dashboard) are flagged **MANUAL**. Everything else is shell.

## 0. Prereqs (already true on the box, listed for sanity)

- EU box: `144.76.199.155`, root SSH from your dev machine works (passwordless).
- Mailcow stack is running on this box with the `reforgedz.net` domain. Web UI: `https://mail.reforgedz.net:8443` (or whatever the Mailcow URL is).
- Cloudflare Tunnel `pterodactyl` (UUID `ecb55935-f7a8-46a0-a3fc-61b3e0558a16`) is active and managed via the Cloudflare Zero Trust dashboard.
- Pterodactyl panel: `https://panel.reforgedz.net`.

## 1. MANUAL: create the Mailcow mailbox

Mailcow → Mailboxes → **Add mailbox**.

- Mailbox part: `noreply`
- Domain: `reforgedz.net`
- Full name: `ReforgedZ Auth`
- Password: generate a strong random one. **Save it** — you'll paste it into the container env in step 4.
- Quota: small (1 GB is plenty).

Send a test email from another account to `noreply@reforgedz.net` to confirm it's accepting mail.

## 2. MANUAL: create the Pterodactyl server for the auth service

Panel → **Servers** → **Create New**.

- Egg: **Node.js Generic** (or your `yolks/nodejs:22` egg)
- Node: `GER1-Official` (the EU box)
- Memory: 256 MB
- Disk: 2 GB
- Allocate a port — anything free on the EU box. **3050** is currently free; use that.
- Startup variables (the egg lets you set these):
  - `STARTUP`: `npm install --omit=dev && node /home/container/server/index.js`
    (or whatever the Node egg's default supports — see your existing admin server's startup for reference)
  - `MAIN_FILE`: `server/index.js`
  - `AUTO_UPDATE`: leave at default if you want git pull on restart
- Once created, note the **volume UUID** from the panel's database view (the long UUID under `/var/lib/pterodactyl/volumes/<UUID>/`). You'll need it in step 3.

Don't start the server yet.

## 3. Push the code (from your dev machine)

```bash
cd c:/Users/heena/Desktop/reforger/reforgedz-auth/deploy
VOLUME_UUID=<paste-uuid-from-panel> bash ./deploy.sh
```

The script will:
- rsync the source tree to `/var/lib/pterodactyl/volumes/<UUID>/`
- `npm install --omit=dev` as the `pterodactyl` user
- Generate the Ed25519 keypair if not already present
- Print the **public key PEM** — save this for step 6.

## 4. MANUAL: set env vars in the panel

Panel → your new server → **Startup** (or **Variables**). Paste in everything from
`deploy/.env.production.template`. Don't forget:

- `SMTP_PASS` = the Mailcow password you generated in step 1.
- `COOKIE_DOMAIN=.reforgedz.net` (leading dot — required for SSO across subdomains)
- `COOKIE_SECURE=true`
- `PORT=3050` (match what you allocated)

Alternative if the panel egg doesn't expose all those vars: put them in `/var/lib/pterodactyl/volumes/<UUID>/.env`. The service reads `dotenv` on boot.

```bash
ssh root@144.76.199.155
cd /var/lib/pterodactyl/volumes/<UUID>/
cp deploy/.env.production.template .env
chown pterodactyl:pterodactyl .env
chmod 600 .env
nano .env   # fill in SMTP_PASS, double-check the rest
```

## 5. MANUAL: add the Cloudflare Tunnel route

Cloudflare Zero Trust dashboard → **Access** → **Tunnels** → `pterodactyl` → **Public Hostname** → **Add a public hostname**.

- Subdomain: `auth`
- Domain: `reforgedz.net`
- Service type: `HTTP`
- URL: `144.76.199.155:3050` (the EU box, port from step 2)
- Additional application settings → HTTP Settings → **HTTP Host Header**: `auth.reforgedz.net`

Save. Within a minute, `https://auth.reforgedz.net` resolves through CF → tunnel → port 3050 on the EU box.

(If you're using a locally-managed tunnel via `/etc/cloudflared/config.yml` instead of the dashboard, add the equivalent ingress rule there and `systemctl reload cloudflared`.)

## 6. Start the container

Panel → Console → **Start**. Watch the log for `[reforgedz-auth] listening on 0.0.0.0:3050`.

Test:
```bash
curl https://auth.reforgedz.net/api/health
# should return {"ok":true,"ts":...}
```

## 7. Bootstrap the first manager

SSH in and run:
```bash
ssh root@144.76.199.155
cd /var/lib/pterodactyl/volumes/<UUID>/
sudo -u pterodactyl npm run bootstrap -- "first-manager"
# prints: https://auth.reforgedz.net/setup?invite=...
```

Open that link in a browser. Pick a username, enter your real email, set a password. We'll email you a 6-digit code. Enter it. You land on `/account` as a manager.

From `/manage` you can now generate invitations for everyone else.

## 8. Distribute the public key to admin + transcripts

The auth service auto-exposes the public key at `https://auth.reforgedz.net/api/auth/public-key`. Admin and transcripts both fetch it at boot via `AUTH_PUBLIC_KEY_URL`.

If you'd rather pin the key in env (recommended for cold-boot resilience), grab it:
```bash
curl https://auth.reforgedz.net/api/auth/public-key
```
…and set it on the admin + transcripts containers:
```
AUTH_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----"
AUTH_BASE=https://auth.reforgedz.net
```

## 9. Update admin + transcripts containers and push

With auth working in prod, you can now safely push the admin and transcripts repos:
```bash
# from your dev machine
cd "c:/Users/heena/Desktop/reforger/reforgedz admin page" && git push
cd "c:/Users/heena/Desktop/ticket-bot/transcript-server" && git push
```

The admin Pterodactyl egg auto-pulls on restart (per the `AUTO_UPDATE=1` flag), so panel → admin server → restart. Same for transcripts.

## 10. Verify cross-site SSO

In an incognito window:
1. Visit `https://admin.reforgedz.net` → redirected to `https://auth.reforgedz.net/login?return=...`
2. Sign in with your manager credentials → 2FA code arrives in your inbox.
3. Enter code → redirected back to `admin.reforgedz.net` and you're authed.
4. Visit `https://transcripts.reforgedz.net` → no second login, you're already in.

## Rollback

If something goes wrong and you need to roll back the admin or transcripts containers:
- Cloudflare dashboard → disable the `auth.reforgedz.net` public hostname route. Login pages on both sites will start 401-ing (since they can't reach the verifier).
- `git revert HEAD` in both `reforgedz admin page` and `transcript-server`, push, restart the containers. They'll go back to their old local login.

The reforgedz-auth container itself can be left running — it won't break anything if no one is hitting it.

## Day-to-day ops

- **Add a new staff member**: log into `auth.reforgedz.net/manage`, click **Invitations** → **Create invitation**, tick perms, copy the link, DM it on Discord.
- **Reset someone's password**: Users tab → click them → **Send reset link**. If they have email on file, Mailcow sends it; otherwise the manager gets a one-time link to share.
- **Revoke a session right now**: Users tab → click them → **Revoke sessions**. They're signed out across all sites within ~60s.
- **See what happened**: Audit tab. Every login, failed attempt, perm change, revoke is logged with IP, GeoIP location, browser + OS.

## Known follow-ups

- **panel.reforgedz.net (Pterodactyl)**: deferred. Needs an OIDC issuer in reforgedz-auth + a Pterodactyl SSO plugin.
- **`admins` table in transcripts SQLite**: still on disk, no longer used. Drop it in a follow-up cleanup once the new auth has run for a week without incident.
- **`data/users.json` in admin**: same — keep on disk for the moment, remove later.
