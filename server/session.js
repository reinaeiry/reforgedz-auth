const { sign, verify, newJti } = require("./jwt");
const db = require("./db");

const DAY_MS = 86400000;

function sessionTtlMs() {
  const days = parseInt(process.env.SESSION_TTL_DAYS || "7", 10);
  return days * DAY_MS;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: String(process.env.COOKIE_SECURE || "true").toLowerCase() !== "false",
    sameSite: "lax",
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
    maxAge: sessionTtlMs()
  };
}

function cookieName() {
  return process.env.COOKIE_NAME || "rz_session";
}

function buildPerms(user) {
  return {
    admin: user.perms.admin,
    transcripts: user.perms.transcripts,
    restricted: user.perms.restricted,
    manager: user.isManager
  };
}

function issueToken(user) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + Math.floor(sessionTtlMs() / 1000);
  return sign({
    sub: String(user.id),
    usr: user.username,
    iat: nowSec,
    exp: expSec,
    jti: newJti(),
    rev: user.tokenVersion,
    perms: buildPerms(user)
  });
}

function setSessionCookie(res, user) {
  const token = issueToken(user);
  res.cookie(cookieName(), token, cookieOptions());
  return token;
}

function clearSessionCookie(res) {
  res.clearCookie(cookieName(), {
    httpOnly: true,
    secure: String(process.env.COOKIE_SECURE || "true").toLowerCase() !== "false",
    sameSite: "lax",
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/"
  });
}

function readSession(req) {
  const raw = req.cookies && req.cookies[cookieName()];
  if (!raw) return null;
  const payload = verify(raw);
  if (!payload) return null;
  const user = db.getUserById(parseInt(payload.sub, 10));
  if (!user) return null;
  if (user.suspended) return null;
  if (user.tokenVersion !== payload.rev) return null;
  return { user, payload };
}

function requireAuth(req, res, next) {
  const sess = readSession(req);
  if (!sess) return res.status(401).json({ error: "unauthorized" });
  req.session = sess;
  next();
}

function requireManager(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.isManager) {
    return res.status(403).json({ error: "manager_required" });
  }
  next();
}

module.exports = {
  cookieName,
  cookieOptions,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  requireAuth,
  requireManager,
  buildPerms,
  issueToken
};
