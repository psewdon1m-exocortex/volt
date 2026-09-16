import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { legacyInstallerAccessKey, writeAccessKeyFile } from "../server/access-key-file.js";
import { hashAccessKey } from "../server/security.js";
import { VoltStore } from "../server/store.js";
import {
  createPortableVault,
  migrateLegacyVault,
  portableVaultInfo,
  unlockPortableVault,
} from "../server/vault-file.js";

test("a 0.1.5 vault and newline-terminated startup key migrate without breaking rollback readability", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "personal-volt-v1-migration-"));
  const filename = path.join(directory, "personal.volt");
  const accessKeyFilename = path.join(directory, "volt-access.key");
  const accessKey = "legacy server access key";
  try {
    createPortableVault({ filename, accessKey }).masterKey.fill(0);
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      UPDATE vault_header SET format_version = 1 WHERE singleton = 1;
      DELETE FROM vault_migrations;
      PRAGMA user_version = 1;
    `);
    legacy.close();
    writeFileSync(accessKeyFilename, `${accessKey}\n`);

    const startupValue = readFileSync(accessKeyFilename, "utf8");
    assert.throws(() => unlockPortableVault({ filename, accessKey: startupValue }), /could not be unlocked/);
    const opened = unlockPortableVault({
      filename,
      accessKey: startupValue,
      legacyAccessKey: legacyInstallerAccessKey(startupValue),
    });
    assert.equal(opened.unlockedWith, "legacy-access-key");

    const store = new VoltStore({ filename, masterKey: opened.masterKey });
    const migrations = store.db.prepare(`
      SELECT scope, version FROM vault_migrations ORDER BY scope, version
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(migrations, [
      { scope: "container", version: 1 },
      { scope: "store", version: 2 },
    ]);
    store.close();

    const info = portableVaultInfo(filename);
    assert.equal(info.format_version, 1);
    assert.equal(info.current_format_version, 2);
    assert.equal(info.schema_version, 2);
    const rollbackCompatible = unlockPortableVault({ filename, accessKey });
    assert.equal(rollbackCompatible.unlockedWith, "access-key");
    rollbackCompatible.masterKey.fill(0);

    writeAccessKeyFile(accessKeyFilename, accessKey);
    assert.equal(readFileSync(accessKeyFilename, "utf8"), accessKey);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("personal.volt preserves exact Access Keys without length rules and survives rotation", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "personal-volt-test-"));
  const filename = path.join(directory, "personal.volt");
  const accessKey = " \tКлюч🙂:/?#[]@! ";
  const nextAccessKey = "k".repeat(513);
  const deviceKey = randomBytes(32);
  try {
    const created = createPortableVault({ filename, accessKey, deviceKey });
    const store = new VoltStore({ filename, masterKey: created.masterKey });
    store.setSetting("access_key_hash", hashAccessKey(accessKey));
    const entry = store.createEntry({
      schema: 1,
      title: "Offline account",
      project: "personal",
      fields: [{ id: crypto.randomUUID(), key: "password", value: "offline-secret-value", visibility: "secret", generator: null }],
    });
    const portableCopy = path.join(directory, "copy.volt");
    writeFileSync(portableCopy, store.createPortableSnapshot());
    store.rotateAccessKey(nextAccessKey, hashAccessKey(nextAccessKey));
    store.close();

    const copied = unlockPortableVault({ filename: portableCopy, accessKey });
    const copiedStore = new VoltStore({ filename: portableCopy, masterKey: copied.masterKey });
    assert.equal(copiedStore.revealField(entry.id, entry.fields[0].id).value, "offline-secret-value");
    copiedStore.close();

    assert.throws(() => unlockPortableVault({ filename: portableCopy, accessKey: accessKey.trim() }), /could not be unlocked/);
    assert.throws(() => unlockPortableVault({ filename, accessKey }), /could not be unlocked/);
    assert.equal(unlockPortableVault({ filename, accessKey: nextAccessKey }).unlockedWith, "access-key");
    assert.equal(unlockPortableVault({ filename, deviceKey, allowDeviceUnlock: true }).unlockedWith, "device");
    assert.equal(portableVaultInfo(filename).format, "exocortex-personal-volt");
    assert.equal(readFileSync(filename).includes(Buffer.from("offline-secret-value")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy volt.sqlite migrates into personal.volt without deleting its rollback source", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "personal-volt-migration-"));
  const legacyFilename = path.join(directory, "volt.sqlite");
  const filename = path.join(directory, "personal.volt");
  const masterKey = randomBytes(32);
  const accessKey = "legacy access key value";
  try {
    const legacy = new VoltStore({ filename: legacyFilename, masterKey });
    legacy.setSetting("access_key_hash", hashAccessKey(accessKey));
    const entry = legacy.createEntry({
      schema: 1,
      title: "Legacy account",
      project: null,
      fields: [{ id: crypto.randomUUID(), key: "token", value: "legacy-secret-value", visibility: "secret", generator: null }],
    });
    legacy.close();

    const migrated = migrateLegacyVault({ legacyFilename, filename, accessKey, legacyMasterKey: masterKey });
    assert.equal(migrated.migrated, true);
    assert.equal(existsSync(legacyFilename), true);
    const opened = unlockPortableVault({ filename, accessKey });
    const store = new VoltStore({ filename, masterKey: opened.masterKey });
    assert.equal(store.revealField(entry.id, entry.fields[0].id).value, "legacy-secret-value");
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an existing access-only personal.volt can enroll a server device key", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "personal-volt-device-"));
  const filename = path.join(directory, "personal.volt");
  const accessKey = "portable access key value";
  const deviceKey = randomBytes(32);
  try {
    createPortableVault({ filename, accessKey });
    assert.equal(portableVaultInfo(filename).has_device_wrapper, false);
    unlockPortableVault({ filename, accessKey, deviceKey });
    assert.equal(portableVaultInfo(filename).has_device_wrapper, true);
    assert.equal(unlockPortableVault({ filename, deviceKey, allowDeviceUnlock: true }).unlockedWith, "device");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
