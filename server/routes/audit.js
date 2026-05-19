const express = require("express");
const db = require("../db");
const session = require("../session");

const router = express.Router();

router.use(session.requireAuth, session.requireManager);

router.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const search = typeof req.query.search === "string" ? req.query.search : "";
  res.json({ entries: db.listAudit({ limit, offset, search }) });
});

module.exports = router;
