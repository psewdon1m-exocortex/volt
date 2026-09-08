import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { deriveSessionKey } from "../server/crypto.js";
import { VoltStore } from "../server/store.js";
import { createPortableVault, unlockPortableVault } from "../server/vault-file.js";

test("Neptune exports the exact manual archive format and keeps controls behind operator auth", async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-neptune-test-"));
  const tokenFile = path.join(directory, "export.token");
  writeFileSync(tokenFile, "export-secret\n");
  const masterKey = randomBytes(32);
  const store = new VoltStore({ filename: path.join(directory, "volt.sqlite"), masterKey });
  let scheduled = null;
  const neptuneClient = {
    status: async () => ({ version: "0.1.0", client_instance_id: "client-test", project: { enabled: false, interval_hours: 24 } }),
    schedule: async (enabled, intervalHours) => { scheduled = { enabled, intervalHours }; },
    run: async () => ({}),
  };
  const app = createApp({ store, sessionKey: deriveSessionKey(masterKey), accessKey: "correct horse battery staple", neptuneClient, neptuneExportTokenFile: tokenFile });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/api/v1/internal/neptune/backup`, { method: "POST" })).status, 401);
  const exported = await fetch(`${base}/api/v1/internal/neptune/backup`, { method: "POST", headers: { authorization: "Bearer export-secret" } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "application/zip");
  assert.ok((await exported.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(`${base}/api/v1/neptune/status`)).status, 401);

  const unlocked = await fetch(`${base}/api/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access_key: "correct horse battery staple" }) });
  const cookie = unlocked.headers.getSetCookie()[0].split(";")[0];
  const response = await fetch(`${base}/api/v1/neptune/schedule`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ enabled: true, interval_hours: 6 }) });
  assert.equal(response.status, 204);
  assert.deepEqual(scheduled, { enabled: true, intervalHours: 6 });
});

test("operator and machine APIs keep list responses masked", async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-api-test-"));
  const portable = createPortableVault({
    filename: path.join(directory, "personal.volt"),
    accessKey: "correct horse battery staple",
  });
  const masterKey = portable.masterKey;
  const store = new VoltStore({ filename: portable.filename, masterKey });
  const app = createApp({
    store,
    sessionKey: deriveSessionKey(masterKey),
    accessKey: "correct horse battery staple",
    kernelToken: "kernel-machine-token-at-least-32-characters",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const deniedUnlock = await fetch(`${base}/api/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_key: "incorrect access key" }),
  });
  assert.equal(deniedUnlock.status, 401);

  const unlocked = await fetch(`${base}/api/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_key: "correct horse battery staple" }),
  });
  assert.equal(unlocked.status, 200);
  const cookie = unlocked.headers.getSetCookie()[0].split(";")[0];
  const secret = "api-secret-value";
  const created = await fetch(`${base}/api/v1/entries`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "API entry", fields: [{ key: "password", value: secret, visibility: "secret" }] }),
  });
  assert.equal(created.status, 201);
  const entry = await created.json();
  assert.equal(entry.fields[0].value, null);

  const list = await fetch(`${base}/api/v1/entries`, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal((await list.text()).includes(secret), false);
  assert.equal(list.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(list.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  const wrongSchemeOrigin = await fetch(`${base}/api/v1/entries`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: base.replace("http:", "https:") },
    body: JSON.stringify({ title: "Rejected", fields: [{ key: "password", value: "must-not-save", visibility: "secret" }] }),
  });
  assert.equal(wrongSchemeOrigin.status, 403);
  const unknownApi = await fetch(`${base}/api/v1/unknown`, { headers: { cookie } });
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.headers.get("content-type").startsWith("application/json"), true);
  const audit = await fetch(`${base}/api/v1/audit`, { headers: { cookie } });
  const auditText = await audit.text();
  assert.equal(audit.status, 200);
  assert.equal(auditText.includes("127.0.0.1"), false);
  assert.equal(auditText.includes("network:"), true);
  const exportedVault = await fetch(`${base}/api/v1/vault-file`, { headers: { cookie } });
  const exportedBytes = Buffer.from(await exportedVault.arrayBuffer());
  assert.equal(exportedVault.status, 200);
  assert.equal(exportedVault.headers.get("content-type"), "application/vnd.exocortex.volt");
  assert.equal(exportedBytes.subarray(0, 16).toString("utf8"), "SQLite format 3\0");
  assert.equal(exportedBytes.includes(Buffer.from(secret)), false);
  const downloadedFilename = path.join(directory, "downloaded-personal.volt");
  writeFileSync(downloadedFilename, exportedBytes);
  const downloaded = unlockPortableVault({ filename: downloadedFilename, accessKey: "correct horse battery staple" });
  const downloadedStore = new VoltStore({ filename: downloadedFilename, masterKey: downloaded.masterKey });
  assert.equal(downloadedStore.revealField(entry.id, entry.fields[0].id).value, secret);
  downloadedStore.close();

  const reference = `volt://${entry.id}/${entry.fields[0].id}`;
  const denied = await fetch(`${base}/api/v1/internal/kernel/resolve`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-kernel-token", "content-type": "application/json" },
    body: JSON.stringify({ references: [reference] }),
  });
  assert.equal(denied.status, 401);
  const resolved = await fetch(`${base}/api/v1/internal/kernel/resolve`, {
    method: "POST",
    headers: { authorization: "Bearer kernel-machine-token-at-least-32-characters", "content-type": "application/json" },
    body: JSON.stringify({ references: [reference] }),
  });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).values[reference].value, secret);
  const postResolveAudit = await fetch(`${base}/api/v1/audit`, { headers: { cookie } });
  assert.equal((await postResolveAudit.text()).includes(secret), false);
  assert.equal((await fetch(`${base}/api/v1/service/resolve`, { method: "POST", headers: { cookie } })).status, 404);
});
