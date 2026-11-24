import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";

const root = process.cwd();
const privPath = path.join(root, "local-private.pem");
const pubPath = path.join(root, "local-public.pem");

if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey);
  console.error("[mint-token] Generated local-private.pem and local-public.pem");
}

const sub = process.argv[2] || "student-1";
const role = process.argv[3] || "student";
const expiresIn = process.argv[4] || "2h";

const privateKey = fs.readFileSync(privPath, "utf8");
const token = jwt.sign({ sub, role }, privateKey, { algorithm: "RS256", expiresIn });
console.log(token);
