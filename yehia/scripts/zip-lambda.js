import fs from "node:fs";
import { execFileSync } from "node:child_process";

const outFile = "lambda.zip";
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

const items = ["src", "fixtures", "node_modules", "package.json"];
if (fs.existsSync("local-public.pem")) items.push("local-public.pem");

const tarBin = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
execFileSync(tarBin, ["-a", "-c", "-f", outFile, ...items], { stdio: "inherit" });

const mb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
console.log(`Created ${outFile} (${mb} MB). .env and local-private.pem are NOT included.`);
