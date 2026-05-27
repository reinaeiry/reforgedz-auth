const express = require("express");
const db = require("../db");
const session = require("../session");

const router = express.Router();

router.use(session.requireAuth, session.requireManager);

router.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const search = typeof req.query.search === "string" ? req.query.search : "";
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const actor = typeof req.query.actor === "string" ? req.query.actor : "";
  const action = typeof req.query.action === "string" ? req.query.action : "";
  const sinceMs = req.query.sinceMs ? parseInt(req.query.sinceMs, 10) : null;
  const untilMs = req.query.untilMs ? parseInt(req.query.untilMs, 10) : null;
  const { entries, total } = db.listAudit({ limit, offset, search, category, actor, action, sinceMs, untilMs });
  res.json({ entries, total, limit, offset });
});

// Facets for the filter UI (categories + counts, distinct actors, actions).
router.get("/facets", (_req, res) => {
  res.json(db.auditFacets());
});

module.exports = router;
