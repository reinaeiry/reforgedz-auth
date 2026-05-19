const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");
const mail = require("./mail");

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateCode() {
  // 6-digit numeric, padded.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

async function startChallenge({ userId, purpose, email, ip, ua }) {
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 8);
  const { id } = db.createPendingLogin({
    userId,
    codeHash,
    purpose,
    ttlMs: CODE_TTL_MS,
    ip,
    ua
  });
  if (email) {
    if (!mail.isEnabled() && process.env.DEV_LOG_2FA === "1") {
      console.log(`[2fa:dev] code for ${email} (purpose=${purpose}): ${code}`);
    } else {
      try {
        await mail.send2faCode(email, code, Math.floor(CODE_TTL_MS / 60000));
      } catch (err) {
        console.error("[2fa] mail send failed:", err.message);
        throw new Error("mail_send_failed");
      }
    }
  }
  return { challengeId: id, expiresInSec: Math.floor(CODE_TTL_MS / 1000) };
}

async function verifyChallenge({ challengeId, code, expectedPurpose }) {
  const row = db.getPendingLogin(challengeId);
  if (!row) return { ok: false, reason: "invalid_challenge" };
  if (row.consumed_at) return { ok: false, reason: "already_used" };
  if (row.expires_at < Date.now()) return { ok: false, reason: "expired" };
  if (row.purpose !== expectedPurpose) return { ok: false, reason: "wrong_purpose" };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const match = await bcrypt.compare(String(code || ""), row.code_hash);
  if (!match) {
    db.bumpPendingAttempts(challengeId);
    return { ok: false, reason: "wrong_code", attemptsRemaining: MAX_ATTEMPTS - row.attempts - 1 };
  }

  db.consumePendingLogin(challengeId);
  return { ok: true, userId: row.user_id };
}

module.exports = { startChallenge, verifyChallenge, CODE_TTL_MS };
