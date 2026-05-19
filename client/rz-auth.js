/**
 * rz-auth — drop-in JWT verifier for reforgedz.net SSO consumers (Node).
 *
 * Usage:
 *   const rzAuth = require("./rz-auth")({
 *     publicKeyPem: process.env.AUTH_PUBLIC_KEY_PEM,         // or
 *     publicKeyUrl: process.env.AUTH_PUBLIC_KEY_URL,         // fetched at boot
 *     authBase: process.env.AUTH_BASE || "https://auth.reforgedz.net",
 *     cookieName: process.env.COOKIE_NAME || "rz_session",
 *     loginUrl: "https://auth.reforgedz.net/login"
 *   });
 *   await rzAuth.ready();
 *   app.use(rzAuth.attachSession);
 *   app.get("/secret", rzAuth.requireAuth, handler);
 *   app.get("/admin", rzAuth.requireAuth, rzAuth.requirePerm("admin.replay"), handler);
 *
 * Token shape:
 *   { sub, usr, iat, exp, jti, rev, perms: { admin:{}, transcripts:{}, restricted:{}, manager } }
 *
 * Revocation: each request optionally re-checks the auth service's /sessions/check
 * (cached 60s per sub+rev) so revoked sessions die within a minute without extra latency.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HEADER_B64 = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");

function decodeB64UrlJSON(s) {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

function getByPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj);
}

function makeVerifier({ publicKeyPem, publicKeyPath, publicKeyUrl, authBase, cookieName = "rz_session", loginUrl, revocationCacheMs = 60000, revocationCheck = true } = {}) {
  let publicKey = null;
  let pubPem = publicKeyPem || null;

  async function fetchPemFromUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("public-key fetch failed: " + res.status);
    return await res.text();
  }

  async function ready() {
    if (publicKey) return;
    if (!pubPem && publicKeyPath) {
      const p = path.resolve(publicKeyPath);
      if (fs.existsSync(p)) pubPem = fs.readFileSync(p, "utf8");
    }
    if (!pubPem && publicKeyUrl) pubPem = await fetchPemFromUrl(publicKeyUrl);
    if (!pubPem) throw new Error("rz-auth: no public key configured");
    publicKey = crypto.createPublicKey(pubPem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("rz-auth: public key must be Ed25519");
  }

  function verifyToken(token) {
    if (!publicKey) throw new Error("rz-auth: call await ready() at boot");
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    if (h !== HEADER_B64) return null;
    let payload;
    try { payload = decodeB64UrlJSON(p); } catch { return null; }
    let sig;
    try { sig = Buffer.from(s, "base64url"); } catch { return null; }
    const ok = crypto.verify(null, Buffer.from(h + "." + p), publicKey, sig);
    if (!ok) return null;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  }

  const revCache = new Map();
  async function checkNotRevoked(payload) {
    if (!revocationCheck || !authBase) return true;
    const key = `${payload.sub}:${payload.rev}`;
    const hit = revCache.get(key);
    const now = Date.now();
    if (hit && hit.expiresAt > now) return hit.valid;
    try {
      const url = `${authBase.replace(/\/+$/, "")}/api/auth/sessions/check?sub=${encodeURIComponent(payload.sub)}&rev=${encodeURIComponent(payload.rev)}`;
      const res = await fetch(url);
      if (!res.ok) return true;
      const data = await res.json();
      revCache.set(key, { valid: !!data.valid, expiresAt: now + revocationCacheMs });
      return !!data.valid;
    } catch {
      return true;
    }
  }

  function readCookie(req) {
    if (req.cookies && req.cookies[cookieName]) return req.cookies[cookieName];
    const header = req.headers && req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq) === cookieName) return decodeURIComponent(part.slice(eq + 1));
    }
    return null;
  }

  async function attachSession(req, _res, next) {
    const raw = readCookie(req);
    if (!raw) return next();
    const payload = verifyToken(raw);
    if (!payload) return next();
    const ok = await checkNotRevoked(payload);
    if (!ok) return next();
    req.rzUser = {
      id: payload.sub,
      username: payload.usr,
      perms: payload.perms || { admin: {}, transcripts: {}, restricted: {}, manager: false },
      jti: payload.jti,
      rev: payload.rev,
      exp: payload.exp
    };
    next();
  }

  function buildLoginRedirect(req) {
    if (!loginUrl) return null;
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const ret = `${proto}://${host}${req.originalUrl || req.url}`;
    return `${loginUrl}?return=${encodeURIComponent(ret)}`;
  }

  function requireAuth(req, res, next) {
    if (req.rzUser) return next();
    if (req.accepts && req.accepts(["html", "json"]) === "html") {
      const dest = buildLoginRedirect(req);
      if (dest) return res.redirect(dest);
    }
    return res.status(401).json({ error: "unauthorized" });
  }

  function requirePerm(permPath) {
    return function (req, res, next) {
      if (!req.rzUser) return res.status(401).json({ error: "unauthorized" });
      if (getByPath(req.rzUser.perms, permPath) === true) return next();
      return res.status(403).json({ error: "forbidden", required: permPath });
    };
  }

  function requireManager(req, res, next) {
    if (!req.rzUser) return res.status(401).json({ error: "unauthorized" });
    if (req.rzUser.perms && req.rzUser.perms.manager) return next();
    return res.status(403).json({ error: "manager_required" });
  }

  return { ready, verifyToken, attachSession, requireAuth, requirePerm, requireManager, _getPublicPem: () => pubPem };
}

module.exports = makeVerifier;
