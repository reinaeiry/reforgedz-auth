#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const outDir = path.resolve(__dirname, "..", "keys");
const privPath = path.join(outDir, "ed25519-private.pem");
const pubPath = path.join(outDir, "ed25519-public.pem");

if (fs.existsSync(privPath) && !process.argv.includes("--force")) {
  console.error("Refusing to overwrite existing private key. Pass --force to regenerate.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));

console.log("Wrote:");
console.log("  " + privPath);
console.log("  " + pubPath);
console.log("");
console.log("Distribute the PUBLIC key to admin/transcripts (env AUTH_PUBLIC_KEY_PEM or AUTH_PUBLIC_KEY_PATH).");
