require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");

const db = require("./db");
const { loadKeys } = require("./keys");
const session = require("./session");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const passwordRoutes = require("./routes/password");
const auditRoutes = require("./routes/audit");

loadKeys();
db.open();

const app = express();
const trust = parseInt(process.env.TRUST_PROXY || "1", 10);
if (!Number.isNaN(trust) && trust > 0) app.set("trust proxy", trust);

app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

const publicDir = path.join(__dirname, "..", "public");

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/password", passwordRoutes);
app.use("/api/audit", auditRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

function sendPage(name) {
  return (_req, res) => res.sendFile(path.join(publicDir, name));
}

app.get("/", (req, res) => {
  const sess = session.readSession(req);
  if (sess) return res.redirect("/account");
  res.redirect("/login");
});
app.get("/login", sendPage("login.html"));
app.get("/forgot", sendPage("forgot.html"));
app.get("/reset", sendPage("reset.html"));
app.get("/setup", sendPage("setup.html"));
app.get("/account", sendPage("account.html"));
app.get("/manage", sendPage("manage.html"));

app.use(express.static(publicDir, { index: false }));

const port = parseInt(process.env.PORT || "3050", 10);
const host = process.env.HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`[reforgedz-auth] listening on ${host}:${port}`);
  console.log(`[reforgedz-auth] cookie domain: ${process.env.COOKIE_DOMAIN || "(host-scoped)"}`);
});
