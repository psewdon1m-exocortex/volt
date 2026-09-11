import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBackupArchive, parseBackupArchive } from "../server/backup.js";
import { VoltStore } from "../server/store.js";
import { createPortableVault, unlockPortableVault } from "../server/vault-file.js";

test("recovery ZIP and mirror independently recover a lost vault, preserving IDs and settings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "volt-recovery-"));
  const key = "audit recovery access key long enough";
  const stores = [];
  try {
    const sourceVault = createPortableVault({ filename: path.join(dir, "source.volt"), accessKey: key, deviceKey: randomBytes(32) });
    const source = new VoltStore(sourceVault); stores.push(source);
    const entry = source.createEntry({ schema: 1, title: "Recovery", project: null, fields: [{ id: randomUUID(), key: "secret", value: "recovery-canary", visibility: "secret", generator: null }] });
    source.setSetting("trash_retention_days", "47");
    const snapshot = source.createPortableSnapshot();
    const archive = Buffer.from(buildBackupArchive(source.exportLogicalState(), "0.1.0", snapshot));
    const inspected = parseBackupArchive(archive);
    assert.equal(inspected.manifest.schema_version, 3);
    assert.ok(inspected.portableSnapshot.equals(snapshot));
    source.close(); stores.pop();
    rmSync(sourceVault.filename);
    const targetVault = createPortableVault({ filename: path.join(dir, "target.volt"), accessKey: key });
    const target = new VoltStore(targetVault); stores.push(target);
    const before = JSON.stringify(target.exportLogicalState());
    assert.throws(() => target.restoreBackup(inspected, { accessKey: "wrong recovery access key" }));
    assert.equal(JSON.stringify(target.exportLogicalState()), before);
    target.restoreBackup(inspected, { accessKey: key });
    assert.equal(target.revealField(entry.id, entry.fields[0].id).value, "recovery-canary");
    assert.equal(target.getSetting("trash_retention_days"), "47");
    writeFileSync(path.join(dir, "mirror.volt"), snapshot);
    const mirror = new VoltStore(unlockPortableVault({ filename: path.join(dir, "mirror.volt"), accessKey: key })); stores.push(mirror);
    assert.equal(mirror.revealField(entry.id, entry.fields[0].id).value, "recovery-canary");
  } finally { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a device key cannot unlock the default strict profile", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "volt-strict-"));
  try {
    const filename = path.join(dir, "personal.volt"), deviceKey = randomBytes(32), accessKey = "strict access key for audit";
    createPortableVault({ filename, accessKey, deviceKey });
    assert.throws(() => unlockPortableVault({ filename, deviceKey }), /could not be unlocked/);
    assert.throws(() => unlockPortableVault({ filename, deviceKey, accessKey: "wrong access key" }), /could not be unlocked/);
    assert.equal(unlockPortableVault({ filename, deviceKey, accessKey }).unlockedWith, "access-key");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
