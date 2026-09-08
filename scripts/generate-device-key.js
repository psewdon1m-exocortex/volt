import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const target = process.argv[2];
if (!target || !path.isAbsolute(target)) {
  console.error("Usage: node scripts/generate-device-key.js <absolute-path>");
  process.exit(2);
}
if (fs.existsSync(target)) {
  console.error("Refusing to overwrite an existing device key file");
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
fs.writeFileSync(target, `${randomBytes(32).toString("base64url")}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
console.log(`Created Volt server device key at ${target}`);
