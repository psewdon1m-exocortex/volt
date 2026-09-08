import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashAccessKey } from "../server/security.js";
import { VoltStore } from "../server/store.js";
import {
  createPortableVault,
  migrateLegacyVault,
  portableVaultInfo,
  unlockPortableVault,
} from "../server/vault-file.js";

test("personal.volt opens offline with its Access Key and survives Access Key rotation", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "personal-volt-test-"));
  const filename = path.join(directory, "personal.volt");
  const accessKey = "correct horse battery staple";
  const nextAccessKey = "another correct battery staple";
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

    assert.throws(() => unlockPortableVault({ filename, accessKey }), /could not be unlocked/);
    assert.equal(unlockPortableVault({ filename, accessKey: nextAccessKey }).unlockedWith, "access-key");
    assert.equal(unlockPortableVault({ filename, deviceKey }).unlockedWith, "device");
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
    assert.equal(unlockPortableVault({ filename, deviceKey }).unlockedWith, "device");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
