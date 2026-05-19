const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let cached = null;

function loadKeys() {
  if (cached) return cached;

  let privPem = process.env.JWT_PRIVATE_KEY_PEM || "";
  let pubPem = process.env.JWT_PUBLIC_KEY_PEM || "";

  if (!privPem && process.env.JWT_PRIVATE_KEY_PATH) {
    const p = path.resolve(process.env.JWT_PRIVATE_KEY_PATH);
    if (fs.existsSync(p)) privPem = fs.readFileSync(p, "utf8");
  }
  if (!pubPem && process.env.JWT_PUBLIC_KEY_PATH) {
    const p = path.resolve(process.env.JWT_PUBLIC_KEY_PATH);
    if (fs.existsSync(p)) pubPem = fs.readFileSync(p, "utf8");
  }

  if (!privPem || !pubPem) {
    throw new Error(
      "Ed25519 keys missing. Run `npm run keys:generate` or set JWT_PRIVATE_KEY_PEM/JWT_PUBLIC_KEY_PEM."
    );
  }

  const privateKey = crypto.createPrivateKey(privPem);
  const publicKey = crypto.createPublicKey(pubPem);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("JWT keys must be Ed25519.");
  }

  cached = { privateKey, publicKey, publicPem: pubPem };
  return cached;
}

function getPublicPem() {
  return loadKeys().publicPem;
}

module.exports = { loadKeys, getPublicPem };
