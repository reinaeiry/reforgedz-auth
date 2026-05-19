# reforgedz-auth

Single-sign-on backend for `*.reforgedz.net` staff. Issues an Ed25519-signed JWT in an `rz_session` cookie on `.reforgedz.net`; admin and transcripts verify the cookie locally with the public key.

## What it does

- Login / logout / `/me` for staff at `auth.reforgedz.net`.
- Manager UI at `/manage` to create users, grant per-tab permissions, generate one-time setup or reset links, revoke sessions, suspend, and delete.
- Audit log of every mutation.
- Password change for the signed-in user.
- Optional email-based self-service reset via the Mailcow server on our EU box. Without email, managers regenerate one-time links and share them via Discord — that flow is the default.

## What it does *not* do (yet)

- **panel.reforgedz.net (Pterodactyl)** — deferred. Pterodactyl is Laravel; it can't read our cookie natively. The follow-up plan is to add an OIDC issuer to this service and install a Pterodactyl SSO plugin. Until then, panel keeps its existing login.

## Stack

- Node 18+ (uses `fetch`, `crypto.sign(null, …)` for Ed25519, `base64url` encoding).
- Express + better-sqlite3 + bcryptjs + cookie-parser + nodemailer + express-rate-limit.
- No build step.

## Setup

```bash
npm install
cp .env.example .env             # edit COOKIE_DOMAIN, SMTP_*, PUBLIC_ORIGIN
npm run keys:generate            # writes keys/ed25519-{private,public}.pem
npm start
```

Open `http://localhost:3050/api/health` to confirm it's up.

### Bootstrap the first manager

The manager UI requires a logged-in manager, but you don't have one yet. Run the CLI:

```bash
npm run manager:create -- IRYS          # or whatever username you want
# prints: https://auth.reforgedz.net/setup?token=…
```

Open the printed link in a browser, set a password, and you're in. From `/manage` you can now create everyone else.

### Distribute the public key

The admin and transcripts services verify the cookie locally with the Ed25519 public key. Two options:

- **Pull**: leave `AUTH_PUBLIC_KEY_URL` set on consumers (default: `https://auth.reforgedz.net/api/auth/public-key`). They fetch the PEM at startup.
- **Pin**: paste `keys/ed25519-public.pem` into each consumer's `AUTH_PUBLIC_KEY_PEM` env var. Safer for offline boots.

## Cookie domain

For SSO across subdomains the cookie must be `.reforgedz.net` (leading dot). Set `COOKIE_DOMAIN=.reforgedz.net` in prod. In local dev, leave it blank so the cookie is host-scoped.

## Permission model

Every user has a permissions blob (see `server/perms.js`):

```
admin: { replay, admin, dev, players, bans, mutes, events, health,
         playerLookup, pii, gmManagement }   # one-to-one with the old admin tools
transcripts: { read, delete, appeals }       # appeals replaces the env-var password
restricted: { access }                       # was the "restricted area" link
manager: boolean                             # top-level — can manage other users
```

Token payload (issued at login, decoded on each request by consumers):

```
{ sub, usr, iat, exp, jti, rev, perms: { admin, transcripts, restricted, manager } }
```

`rev` is the user's `token_version`. On revoke / password change / suspend, we bump `token_version`; consumers compare `payload.rev` against `/api/auth/sessions/check?sub=…&rev=…` (cached 60s) so sessions die within a minute.

## Manager flow

1. Create user → enter username, optional email, tick the perm boxes, **Save**.
2. The UI returns a one-time `setup` link (24h). Copy and DM it.
3. User opens the link, sets a password, lands signed in on `account.html`.
4. Need to reset? Click **Reset password**. If they have email on file, an email goes out via Mailcow; otherwise the manager gets a one-time link to share.
5. Adjust permissions any time — within ~60s the user's cached perms refresh on admin/transcripts.
6. **Revoke sessions** invalidates every active session for that user.

## Consumer wiring

Both `admin.reforgedz.net` and `transcripts.reforgedz.net` import the same verifier shape:

```js
const rzAuth = createRzAuth({
  publicKeyUrl: process.env.AUTH_PUBLIC_KEY_URL,
  authBase: process.env.AUTH_BASE,           // https://auth.reforgedz.net
  loginUrl: process.env.AUTH_BASE + '/login',
  cookieName: 'rz_session'
});
await rzAuth.ready();
app.use(rzAuth.attachSession);

app.get('/api/secret', rzAuth.requireAuth, handler);
app.get('/api/admin/bans', rzAuth.requireAuth, rzAuth.requirePerm('admin.bans'), handler);
```

Admin uses ESM (`server/lib/rz-auth.js`). Transcripts uses CJS (`lib/rz-auth.js`). Both are local copies — keep them in sync.

## Deploy on the EU box

The EU Mailcow box (`144.76.199.155`) is the right host for this service:

1. New Pterodactyl Node.js container, ~256 MB RAM, on the EU node. Path on host: `/var/lib/pterodactyl/volumes/<uuid>/`.
2. Clone this repo into the container's home, `npm install`, `npm run keys:generate`.
3. Set env: `PORT=3050`, `HOST=127.0.0.1`, `COOKIE_DOMAIN=.reforgedz.net`, `COOKIE_SECURE=true`, `PUBLIC_ORIGIN=https://auth.reforgedz.net`, `SMTP_*` (point at the local Mailcow), `MAIL_FROM=noreply@reforgedz.net`.
4. Create the `noreply@reforgedz.net` mailbox in the Mailcow UI (port 8443 on the EU box) and put its SMTP credentials in `SMTP_USER` / `SMTP_PASS`.
5. Add the Cloudflare Tunnel ingress rule (see `reforger/reforgedz admin page/infra/cloudflared/config.yml.example`).
6. `npm run manager:create -- <username>` and DM the setup link to the first manager.

## Files

```
server/
  index.js              — Express app + static page routes
  db.js                 — better-sqlite3 schema (users, setup_tokens, audit_log)
  perms.js              — permission shape + normalization
  keys.js               — Ed25519 PEM load
  jwt.js                — sign / verify
  session.js            — cookie ops, requireAuth / requireManager
  mail.js               — nodemailer wrapper (Mailcow)
  routes/
    auth.js             — /login /logout /me /sessions/check /public-key
    users.js            — manager-only CRUD + setup-link + reset + revoke
    password.js         — /forgot /redeem /change /token-info
    audit.js            — audit log read

scripts/
  generate-keys.js      — one-shot Ed25519 keypair generation
  create-manager.js     — bootstrap CLI for the first manager

client/
  rz-auth.js            — CommonJS verifier module copied into transcripts

public/
  login.html  forgot.html  reset.html  setup.html  account.html
  manage.html manage.js  style.css
```
