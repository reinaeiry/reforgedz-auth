# reforgedz-auth

Single sign-on backend for `*.reforgedz.net` staff. Issues an Ed25519-signed JWT in an `rz_session` cookie on `.reforgedz.net`; admin and transcripts verify the cookie locally with the public key. Every login is gated by an email-delivered 6-digit code.

## What it does

- **Login**: username + password, then a 6-digit code sent to the user's email on file.
- **Self-service invitations**: managers generate one-time invite links with perms attached. The user opens the link, fills in their own username + email + password, confirms email with a 6-digit code, and lands logged in.
- **Password reset**: forgot-password emails a link; redemption sets a new password and triggers email 2FA before issuing the session.
- **Per-tab permission grid**: 10 admin tools (replay / players / bans / …), 3 transcripts perms (read / delete / appeals), 1 restricted area, plus a manager flag.
- **Audit log**: every action — login OK, login failed, 2FA failed, invitation created, password reset, perms changed, session revoked — recorded with **IP, GeoIP country/region/city, browser, OS, device**.
- **Revoke immediately**: bump the user's token_version; sessions die across all sites within ~60s.

## What it does NOT do (deferred)

- **panel.reforgedz.net (Pterodactyl)** — Laravel app, can't read our cookie natively. Plan is to add an OIDC issuer to this service + install a Pterodactyl SSO plugin. Until then, panel keeps its existing login.

## Stack

- Node 18+ (uses `fetch`, Ed25519 via `crypto.sign`/`verify`)
- Express + better-sqlite3 + bcryptjs + cookie-parser + nodemailer + express-rate-limit + ua-parser-js + geoip-lite
- No build step

## Setup (local dev)

```bash
npm install
cp .env.example .env
npm run keys:generate
npm start
```

To exercise 2FA without a real SMTP server, set `SMTP_HOST=` and `DEV_LOG_2FA=1`. Codes get logged to the console instead of emailed.

### Bootstrap the first manager

```bash
npm run bootstrap -- "first-manager"
# prints: https://auth.reforgedz.net/setup?invite=<token>
```

Open the link, enter your username + email + password, then the 6-digit code we email you. You land at `/account` as a manager. From `/manage` you can issue invitations for everyone else.

## Deploy to the EU Pterodactyl box

See [deploy/EU-DEPLOY.md](deploy/EU-DEPLOY.md). Summary:

1. Mailcow UI → create `noreply@reforgedz.net` mailbox.
2. Pterodactyl panel → new Node.js server, note volume UUID.
3. `VOLUME_UUID=<uuid> bash deploy/deploy.sh` from your dev machine — rsyncs code, installs deps, generates Ed25519 keys, prints the public key.
4. Set env on the container from [deploy/.env.production.template](deploy/.env.production.template).
5. Cloudflare Zero Trust dashboard → tunnel `pterodactyl` → add public hostname `auth.reforgedz.net` → `http://localhost:3050`.
6. Start the container, run `npm run bootstrap -- first-manager`, open the link.
7. Push the admin + transcripts repos so they switch to cookie-based auth.

## Distributing the public key

Two ways:

- **Pull** (default): consumers set `AUTH_PUBLIC_KEY_URL=https://auth.reforgedz.net/api/auth/public-key`. They fetch it at boot. Single source of truth, but boot fails if auth is down.
- **Pin**: set `AUTH_PUBLIC_KEY_PEM="<paste>"` on the consumer. Cold-boot resilient. Update both consumers if you ever rotate the key.

## Permission model

```
admin: { replay, admin, dev, players, bans, mutes, events, health, playerLookup, pii, gmManagement }
transcripts: { read, delete, appeals }
restricted: { access }
manager: boolean    // can manage other users
```

Token payload:
```
{ sub, usr, iat, exp, jti, rev, perms: { admin, transcripts, restricted, manager } }
```

`rev` is the user's `token_version`. Revoke / password-change / suspend bumps it. Consumers run a cached (60s) `/api/auth/sessions/check?sub=…&rev=…` per request, so revoked sessions die within a minute without an extra RTT per page.

## API surface

Public:
- `POST /api/auth/login` `{username, password}` → `{needs2fa, challengeId, emailHint}` (no session cookie yet).
- `POST /api/auth/2fa/verify` `{challengeId, code}` → session cookie set, returns user.
- `POST /api/auth/2fa/resend` `{challengeId}` → new challenge, old one invalidated.
- `POST /api/auth/logout`
- `GET  /api/auth/me`
- `GET  /api/auth/sessions/check?sub&rev`
- `GET  /api/auth/public-key`
- `POST /api/password/forgot` `{username}` (responds 200 always, sends email if user exists)
- `GET  /api/password/token-info?invite=...` or `?token=...&purpose=reset`
- `POST /api/password/invite/redeem` `{invite, username, email, password}` → `{needs2fa, challengeId, emailHint}`
- `POST /api/password/reset/redeem` `{token, password}` → `{needs2fa, challengeId, emailHint}`
- `POST /api/password/change` `{current, password}` (auth required)

Manager-only (require `perms.manager` on the cookie):
- `GET    /api/users` — active users.
- `PATCH  /api/users/:id` — edit email / perms / manager / suspended.
- `POST   /api/users/:id/reset` — generate reset link, email if possible.
- `POST   /api/users/:id/revoke` — bump token_version.
- `DELETE /api/users/:id` — delete (cannot delete yourself).
- `GET    /api/users/invites/list` — all invitations, with status.
- `POST   /api/users/invites` `{perms, isManager, label}` → `{inviteUrl, expiresAt}`.
- `DELETE /api/users/invites/:id` — revoke pending invitation.
- `GET    /api/audit?limit&offset&search` — audit log.

## Consumer wiring

Both admin and transcripts use a local copy of `client/rz-auth.js`:

```js
const rzAuth = createRzAuth({
  publicKeyUrl: process.env.AUTH_PUBLIC_KEY_URL,
  authBase: process.env.AUTH_BASE,
  loginUrl: process.env.AUTH_BASE + '/login',
  cookieName: 'rz_session'
});
await rzAuth.ready();
app.use(rzAuth.attachSession);

app.get('/api/admin/bans', rzAuth.requireAuth, rzAuth.requirePerm('admin.bans'), handler);
```

Admin uses the ESM version at `reforgedz admin page/server/lib/rz-auth.js`. Transcripts uses the CJS version at `transcript-server/lib/rz-auth.js`. They're independent copies — keep in sync when rotating the verifier logic.

## Files

```
server/
  index.js             — Express app + page routes
  db.js                — SQLite: users, setup_tokens, invitations, pending_logins, audit_log
  perms.js             — permission shape + normalization
  keys.js              — Ed25519 PEM load
  jwt.js               — sign / verify
  session.js           — cookie ops, requireAuth, requireManager
  reqctx.js            — IP + GeoIP + UA-parse for audit context
  twofa.js             — code generation + email + verification
  mail.js              — Mailcow SMTP wrapper (password reset + 2FA codes)
  routes/
    auth.js            — login (with 2FA), logout, me, sessions/check, public-key
    users.js           — manager CRUD + invitations
    password.js        — forgot, invite/redeem, reset/redeem, change, token-info
    audit.js           — audit log read (with search)

scripts/
  generate-keys.js     — Ed25519 keypair
  create-manager.js    — bootstrap first manager via invitation (npm run bootstrap)

client/
  rz-auth.js           — CJS verifier copied into transcripts

public/
  login.html  forgot.html  reset.html  setup.html  account.html
  manage.html  manage.js  style.css

deploy/
  EU-DEPLOY.md         — step-by-step EU box deploy
  deploy.sh            — rsync + remote install + key gen
  .env.production.template
```
