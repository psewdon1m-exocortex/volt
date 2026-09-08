import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { createApp } from "./app.js";
import { deriveSessionKey, readMasterKey } from "./crypto.js";
import { validateRuntimeConfig } from "./security.js";
import { VoltStore } from "./store.js";
import { createNeptuneClient } from "./neptune-client.js";
import { createUpdaterClient } from "./updater-client.js";
import { createPortableVault, migrateLegacyVault, unlockPortableVault } from "./vault-file.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, "..");
const dataDir = path.resolve(process.env.VOLT_DATA_DIR || path.join(rootDir, "data"));
const vaultFilename = path.resolve(process.env.VOLT_VAULT_FILE || path.join(dataDir, "personal.volt"));
const legacyFilename = path.resolve(process.env.VOLT_LEGACY_DATABASE_FILE || path.join(dataDir, "volt.sqlite"));
const deviceKeyFile = process.env.VOLT_DEVICE_KEY_FILE || process.env.VOLT_MASTER_KEY_FILE;
const legacyMasterKeyFile = process.env.VOLT_LEGACY_MASTER_KEY_FILE || process.env.VOLT_MASTER_KEY_FILE;
const deviceKey = deviceKeyFile ? readMasterKey(path.resolve(deviceKeyFile)) : null;
const legacyMasterKey = legacyMasterKeyFile ? readMasterKey(path.resolve(legacyMasterKeyFile)) : null;
const accessKey = process.env.VOLT_ACCESS_KEY_FILE
  ? fs.readFileSync(path.resolve(process.env.VOLT_ACCESS_KEY_FILE), "utf8").trim()
  : process.env.VOLT_ACCESS_KEY;
const updaterControlToken = process.env.UPDATER_CONTROL_TOKEN_FILE
  ? fs.readFileSync(path.resolve(process.env.UPDATER_CONTROL_TOKEN_FILE), "utf8").trim()
  : process.env.UPDATER_CONTROL_TOKEN || "";
const kernelToken = process.env.VOLT_KERNEL_TOKEN_FILE
  ? fs.readFileSync(path.resolve(process.env.VOLT_KERNEL_TOKEN_FILE), "utf8").trim()
  : process.env.VOLT_KERNEL_TOKEN;
let vault;
if (fs.existsSync(vaultFilename)) {
  vault = unlockPortableVault({ filename: vaultFilename, accessKey, deviceKey });
} else if (fs.existsSync(legacyFilename)) {
  if (!legacyMasterKey) throw new Error("VOLT_LEGACY_MASTER_KEY_FILE is required to migrate volt.sqlite");
  vault = migrateLegacyVault({
    legacyFilename,
    filename: vaultFilename,
    accessKey,
    legacyMasterKey,
    deviceKey: deviceKey || legacyMasterKey,
  });
  console.warn(`Migrated legacy Volt storage to ${vaultFilename}; the source database was retained for rollback`);
} else {
  vault = createPortableVault({ filename: vaultFilename, accessKey, deviceKey });
}
validateRuntimeConfig({ accessKey, masterKey: vault.masterKey, kernelToken, requireAccessKey: vault.created || vault.migrated });

const store = new VoltStore({
  filename: vaultFilename,
  masterKey: vault.masterKey,
  auditRetention: Number(process.env.VOLT_AUDIT_RETENTION || 10_000),
});
const host = process.env.VOLT_LISTEN_HOST || "127.0.0.1";
const port = Number(process.env.VOLT_PORT || 18184);
const app = createApp({
  store,
  sessionKey: deriveSessionKey(vault.masterKey),
  accessKey,
  kernelToken,
  secureCookies: process.env.VOLT_SECURE_COOKIES === "true",
  trustProxy: process.env.VOLT_TRUST_PROXY === "true" ? 1 : false,
  distDir: path.join(rootDir, "dist"),
  neptuneClient: createNeptuneClient({
    socketPath: process.env.NEPTUNE_SOCKET_PATH || "/run/neptune/neptuned.sock",
    projectId: process.env.NEPTUNE_PROJECT_ID || "volt",
    controlTokenFile: process.env.NEPTUNE_CONTROL_TOKEN_FILE,
  }),
  updaterClient: createUpdaterClient({
    socketPath: process.env.UPDATER_SOCKET_PATH || "/run/exocortex/updater.sock",
    controlToken: updaterControlToken,
    headId: process.env.UPDATER_REGISTERED_HEAD_ID || "volt-production",
  }),
  neptuneExportTokenFile: process.env.NEPTUNE_EXPORT_TOKEN_FILE,
});

const server = app.listen(port, host, () => {
  console.log(`Volt is listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    store.checkpoint();
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
