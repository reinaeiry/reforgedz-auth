const express = require("express");
const crypto = require("crypto");
const db = require("../db");

const router = express.Router();

// Constant-time bearer key check.
function authorize(req, res, next) {
  const expected = process.env.INTERNAL_AUDIT_KEY || "";
  if (!expected) return res.status(503).json({ error: "internal_audit_disabled" });
  const header = req.headers.authorization || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return res.status(401).json({ error: "missing_bearer" });
  const got = Buffer.from(header.slice(prefix.length));
  const exp = Buffer.from(expected);
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) {
    return res.status(401).json({ error: "bad_bearer" });
  }
  next();
}

router.post("/", authorize, (req, res) => {
  const {
    actorUsername,
    action,
    targetUserId,
    targetUsername,
    detail,
    ip,
    ua,
    browser,
    os,
    device,
    deviceLabel,
    geoCountry,
    geoRegion,
    geoCity,
    geoLabel
  } = req.body || {};

  if (!action || typeof action !== "string") {
    return res.status(400).json({ error: "missing_action" });
  }

  db.logAudit({
    actorId: null,
    actorUsername: actorUsername || null,
    action: String(action).slice(0, 64),
    targetUserId: targetUserId || null,
    targetUsername: targetUsername || null,
    detail: detail && typeof detail === "object" ? detail : null,
    ctx: {
      ip: ip || null,
      ua: ua || null,
      browser: browser || null,
      os: os || null,
      device: device || null,
      deviceLabel: deviceLabel || null,
      geo: { country: geoCountry, region: geoRegion, city: geoCity },
      geoLabel: geoLabel || null
    }
  });

  res.json({ ok: true });
});

module.exports = router;
