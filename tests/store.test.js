import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseVoltReference, VoltStore } from "../server/store.js";
import { buildBackupArchive, parseBackupArchive } from "../server/backup.js";

function withStore(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-test-"));
  const filename = path.join(directory, "volt.sqlite");
  const store = new VoltStore({ filename, masterKey: randomBytes(32) });
  try {
    return run(store, filename);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function entryPayload(value = "correct horse battery staple") {
  return {
    schema: 1,
    title: "Google account",
    project: "personal",
    fields: [
      { id: randomUUID(), key: "email", value: "hello@example.test", visibility: "plain", generator: null },
      { id: randomUUID(), key: "password", value, visibility: "secret", generator: null },
    ],
  };
}

test("entry values are encrypted and list responses mask secret fields", () => withStore((store, filename) => {
  const plaintext = "volt-test-secret-that-must-not-leak";
  const entry = store.createEntry(entryPayload(plaintext));
  assert.equal(entry.fields[1].value, null);
  assert.equal(entry.fields[1].masked, true);
  assert.equal(store.revealField(entry.id, entry.fields[1].id).value, plaintext);
  store.checkpoint();
  assert.equal(readFileSync(filename).includes(Buffer.from(plaintext)), false);
}));

test("updates append immutable revisions and restore creates another revision", () => withStore((store) => {
  const created = store.createEntry(entryPayload("v1"));
  const payload = entryPayload("v2");
  payload.fields = created.fields.map((field, index) => ({
    id: field.id,
    key: field.key,
    value: index === 1 ? "v2" : "hello@example.test",
    visibility: field.visibility,
    generator: null,
  }));
  const updated = store.updateEntry(created.id, payload, { expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(store.revealField(created.id, created.fields[1].id, { revisionNumber: 1 }).value, "v1");
  const restored = store.restoreRevision(created.id, 1);
  assert.equal(restored.revision, 3);
  assert.equal(store.revealField(created.id, created.fields[1].id).value, "v1");
  assert.deepEqual(store.getRevisions(created.id).map((revision) => revision.revision), [3, 2, 1]);
}));

test("Kernel resolution decrypts exact references without storing plaintext", () => withStore((store) => {
  const entry = store.createEntry(entryPayload("machine-secret"));
  const plainRef = `volt://${entry.id}/${entry.fields[0].id}`;
  const secretRef = `volt://${entry.id}/${entry.fields[1].id}`;
  const parsed = parseVoltReference(secretRef);
  assert.equal(parsed.entryId, entry.id);
  const result = store.resolveReferences([plainRef, secretRef]);
  assert.deepEqual(result.values[plainRef], { value: "hello@example.test", revision: 1, visibility: "plain" });
  assert.deepEqual(result.values[secretRef], { value: "machine-secret", revision: 1, visibility: "secret" });
  assert.equal(JSON.stringify(store.listAudit()).includes("machine-secret"), false);
}));

test("optimistic concurrency rejects stale edits", () => withStore((store) => {
  const created = store.createEntry(entryPayload("v1"));
  const next = entryPayload("v2");
  next.fields = next.fields.map((field, index) => ({ ...field, id: created.fields[index].id }));
  store.updateEntry(created.id, next, { expectedRevision: 1 });
  assert.throws(() => store.updateEntry(created.id, next, { expectedRevision: 1 }), { code: "ENTRY_REVISION_CONFLICT" });
}));

test("logical backup round-trips ciphertext and history without machine credentials", () => withStore((source) => {
  source.setSetting("access_key_hash", "source-access-verifier");
  const entry = source.createEntry(entryPayload("backup-secret"));
  const next = entryPayload("backup-secret-v2");
  next.fields = next.fields.map((field, index) => ({ ...field, id: entry.fields[index].id }));
  source.updateEntry(entry.id, next, { expectedRevision: 1 });
  const masterKey = source.masterKey;
  const archive = buildBackupArchive(source.exportLogicalState());
  const parsed = parseBackupArchive(Buffer.from(archive));
  assert.equal(parsed.state.settings.some((row) => row.key === "access_key_hash"), false);

  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-restore-test-"));
  const restored = new VoltStore({ filename: path.join(directory, "restored.sqlite"), masterKey });
  try {
    restored.setSetting("access_key_hash", "destination-access-verifier");
    restored.importLogicalState(parsed.state, { archiveDigest: parsed.digest });
    assert.equal(restored.getSetting("access_key_hash"), "destination-access-verifier");
    assert.equal(restored.getEntry(entry.id).revision, 2);
    assert.equal(restored.revealField(entry.id, entry.fields[1].id, { revisionNumber: 1 }).value, "backup-secret");
    assert.equal(Object.hasOwn(parsed.state, "principals"), false);
    assert.equal(Object.hasOwn(parsed.state, "grants"), false);
  } finally {
    restored.close();
    rmSync(directory, { recursive: true, force: true });
  }
}));
