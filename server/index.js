import path from "node:path";
import { trustedProxies } from "./proxy-policy.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { createApp } from "./app.js";
import { createLockedRuntime } from "./locked-runtime.js";
import { deriveSessionKey, readMasterKey } from "./crypto.js";
import { validateRuntimeConfig } from "./security.js";
import { VoltStore } from "./store.js";
import { createNeptuneClient } from "./neptune-client.js";
import { createUpdaterClient } from "./updater-client.js";
import { createPortableVault, migrateLegacyVault, unlockPortableVault } from "./vault-file.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, "..");
const appVersion = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
const dataDir = path.resolve(process.env.VOLT_DATA_DIR || path.join(rootDir, "data"));
const vaultFilename = path.resolve(process.env.VOLT_VAULT_FILE || path.join(dataDir, "personal.volt"));
const legacyFilename = path.resolve(process.env.VOLT_LEGACY_DATABASE_FILE || path.join(dataDir, "volt.sqlite"));
const deviceKeyFile = process.env.VOLT_DEVICE_KEY_FILE || process.env.VOLT_MASTER_KEY_FILE;
const legacyMasterKeyFile = process.env.VOLT_LEGACY_MASTER_KEY_FILE || process.env.VOLT_MASTER_KEY_FILE;
const deviceKey = deviceKeyFile ? readMasterKey(path.resolve(deviceKeyFile)) : null;
const legacyMasterKey = legacyMasterKeyFile ? readMasterKey(path.resolve(legacyMasterKeyFile)) : null;
const bootstrapAccessKey = process.env.VOLT_ACCESS_KEY_FILE
  ? fs.readFileSync(path.resolve(process.env.VOLT_ACCESS_KEY_FILE), "utf8").trim()
  : process.env.VOLT_ACCESS_KEY;
const updaterControlToken = process.env.UPDATER_CONTROL_TOKEN_FILE
  ? fs.readFileSync(path.resolve(process.env.UPDATER_CONTROL_TOKEN_FILE), "utf8").trim()
  : process.env.UPDATER_CONTROL_TOKEN || "";
const kernelToken = process.env.VOLT_KERNEL_TOKEN_FILE
  ? fs.readFileSync(path.resolve(process.env.VOLT_KERNEL_TOKEN_FILE), "utf8").trim()
  : process.env.VOLT_KERNEL_TOKEN;
let vault;
let store;
const host = process.env.VOLT_LISTEN_HOST || "127.0.0.1";
const port = Number(process.env.VOLT_PORT || 18184);
function unlockRuntime(accessKey) {
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

store = new VoltStore({
  filename: vaultFilename,
  masterKey: vault.masterKey,
  auditRetention: Number(process.env.VOLT_AUDIT_RETENTION || 10_000),
});
return createApp({
  store,
  sessionKey: deriveSessionKey(vault.masterKey),
  accessKey,
  appVersion,
  kernelUrlSeed: process.env.VOLT_KERNEL_URL || "http://127.0.0.1:18180",
  kernelServiceUrl: process.env.KERNEL_URL || "",
  kernelServiceToken: process.env.KERNEL_SERVICE_TOKEN || "",
  kernelToken,
  secureCookies: process.env.VOLT_SECURE_COOKIES === "true",
  trustProxy: trustedProxies(process.env.VOLT_TRUSTED_PROXIES),
  distDir: path.join(rootDir, "dist"),
  neptuneClient: createNeptuneClient({
    socketPath: process.env.NEPTUNE_SOCKET_PATH || "/run/neptune/neptuned.sock",
    projectId: process.env.NEPTUNE_PROJECT_ID || "volt",
    controlTokenFile: process.env.NEPTUNE_CONTROL_TOKEN_FILE,
  }),
  updaterClient: createUpdaterClient({
    socketPath: process.env.UPDATER_SOCKET_PATH || "/run/exocortex/updater.sock",
    controlToken: updaterControlToken,
    headId: process.env.UPDATER_HEAD_ID || process.env.UPDATER_REGISTERED_HEAD_ID || "volt",
  }),
  updaterControlToken,
  neptuneExportTokenFile: process.env.NEPTUNE_EXPORT_TOKEN_FILE,
  neptuneExportUrl: `http://127.0.0.1:${port}/api/v1/internal/neptune/backup`,
});

}
const app = createLockedRuntime({
  unlock: unlockRuntime,
  distDir: path.join(rootDir, "dist"),
  initialApp: bootstrapAccessKey ? unlockRuntime(bootstrapAccessKey) : null,
  trustProxy: trustedProxies(process.env.VOLT_TRUSTED_PROXIES),
});

const server = app.listen(port, host, () => {
  console.log(`Volt is listening on http://${host}:${port}`);
});
const trashRetentionTimer = setInterval(() => {
  try {
    const purged = store?.purgeExpiredEntries();
    if (purged) console.log(`Permanently deleted ${purged} expired trash ${purged === 1 ? "entry" : "entries"}`);
  } catch (error) {
    console.error("Could not run trash retention cleanup", error);
  }
}, 60_000);
trashRetentionTimer.unref();

function shutdown() {
  clearInterval(trashRetentionTimer);
  server.close(() => {
    store?.checkpoint();
    store?.close();
    vault?.masterKey.fill(0);
    deviceKey?.fill(0);
    legacyMasterKey?.fill(0);
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
