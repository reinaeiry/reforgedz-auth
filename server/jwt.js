const crypto = require("crypto");
const { loadKeys } = require("./keys");

const HEADER = { alg: "EdDSA", typ: "JWT" };
const HEADER_B64 = b64url(JSON.stringify(HEADER));

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function b64urlJSON(obj) {
  return b64url(JSON.stringify(obj));
}

function decodeB64UrlJSON(s) {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

function sign(payload) {
  const { privateKey } = loadKeys();
  const body = b64urlJSON(payload);
  const signingInput = HEADER_B64 + "." + body;
  const sig = crypto.sign(null, Buffer.from(signingInput), privateKey);
  return signingInput + "." + sig.toString("base64url");
}

function verify(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (h !== HEADER_B64) return null;
  let payload;
  try {
    payload = decodeB64UrlJSON(p);
  } catch {
    return null;
  }
  const { publicKey } = loadKeys();
  let sig;
  try {
    sig = Buffer.from(s, "base64url");
  } catch {
    return null;
  }
  const ok = crypto.verify(null, Buffer.from(h + "." + p), publicKey, sig);
  if (!ok) return null;
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function newJti() {
  return crypto.randomBytes(12).toString("base64url");
}

module.exports = { sign, verify, newJti };
