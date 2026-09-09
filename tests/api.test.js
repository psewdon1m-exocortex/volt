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
  assert.equal((await fetch(`${base}/api/v1/internal/neptune/mirror`, { method: "POST" })).status, 401);
  const mirrored = await fetch(`${base}/api/v1/internal/neptune/mirror`, { method: "POST", headers: { authorization: "Bearer export-secret" } });
  assert.equal(mirrored.status, 200);
  assert.equal(mirrored.headers.get("content-type"), "application/octet-stream");
  assert.match(mirrored.headers.get("content-disposition") ?? "", /personal\.volt/);
  assert.ok((await mirrored.arrayBuffer()).byteLength > 0);
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
    kernelUrlSeed: "http://127.0.0.1:1",
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
  assert.equal(store.getSetting("kernel_token_hash")?.length, 64);
  assert.notEqual(store.getSetting("kernel_token_hash"), "kernel-machine-token-at-least-32-characters");
  const kernelAccess = await fetch(`${base}/api/v1/settings/kernel-access`, { headers: { cookie } });
  const kernelStatus = await kernelAccess.json();
  assert.equal(kernelStatus.configured, true);
  assert.equal(kernelStatus.url, "http://127.0.0.1:1");
  assert.equal(kernelStatus.reachable, false);

  const dashboard = await fetch(`${base}/api/v1/dashboard`, { headers: { cookie } });
  const metrics = await dashboard.json();
  assert.equal(dashboard.status, 200);
  assert.equal(metrics.entries, 0);
  assert.ok(metrics.memory.total_bytes > 0);
  assert.ok(metrics.cpu.logical_cores > 0);

  const interfaceUpdate = await fetch(`${base}/api/v1/settings/interface`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accent: "#62FF8C", sidebar_mode: "auto", navigation_order: ["vault", "dashboard", "trash", "audit", "settings"] }),
  });
  const interfaceSettings = await interfaceUpdate.json();
  assert.equal(interfaceUpdate.status, 200);
  assert.equal(interfaceSettings.accent, "#62FF8C");
  assert.equal(interfaceSettings.sidebar_mode, "auto");
  assert.deepEqual(interfaceSettings.navigation_order, ["vault", "dashboard", "trash", "audit", "settings"]);
  const secret = "api-secret-value";
  const created = await fetch(`${base}/api/v1/entries`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "API entry", fields: [{ key: "password", value: secret, visibility: "secret" }] }),
  });
  assert.equal(created.status, 201);
  const entry = await created.json();
  assert.equal(entry.fields[0].value, null);
  const dashboardWithEntry = await fetch(`${base}/api/v1/dashboard`, { headers: { cookie } });
  assert.equal((await dashboardWithEntry.json()).entries, 1);

  const certificateResponse = await fetch(`${base}/api/v1/generate`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: "certificate", common_name: "localhost", sans: ["localhost", "127.0.0.1"], valid_days: 365 }),
  });
  const certificate = await certificateResponse.json();
  assert.equal(certificateResponse.status, 200);
  assert.equal(certificate.kind, "certificate");
  assert.equal(certificate.values.length, 2);
  assert.match(certificate.values[0].value, /BEGIN CERTIFICATE/);

  const list = await fetch(`${base}/api/v1/entries`, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal((await list.text()).includes(secret), false);
  assert.equal(list.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(list.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");

  assert.equal((await fetch(`${base}/api/v1/entries/${entry.id}`, { method: "DELETE", headers: { cookie } })).status, 204);
  const trashResponse = await fetch(`${base}/api/v1/trash`, { headers: { cookie } });
  const trash = await trashResponse.json();
  assert.equal(trashResponse.status, 200);
  assert.equal(trash.retention_days, 30);
  assert.equal(trash.entries[0].id, entry.id);
  assert.equal(JSON.stringify(trash).includes(secret), false);
  assert.equal((await fetch(`${base}/api/v1/trash/${entry.id}/restore`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status, 200);

  const disposableResponse = await fetch(`${base}/api/v1/entries`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "Disposable", fields: [{ key: "value", value: "erase-me", visibility: "secret" }] }),
  });
  const disposable = await disposableResponse.json();
  assert.equal((await fetch(`${base}/api/v1/entries/${disposable.id}`, { method: "DELETE", headers: { cookie } })).status, 204);
  assert.equal((await fetch(`${base}/api/v1/trash/${disposable.id}`, { method: "DELETE", headers: { cookie } })).status, 204);
  assert.equal((await fetch(`${base}/api/v1/trash/${disposable.id}/restore`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status, 404);
  const trashSettingsResponse = await fetch(`${base}/api/v1/settings/trash`, { headers: { cookie } });
  assert.deepEqual(await trashSettingsResponse.json(), { retention_days: 30, min_days: 1, max_days: 365 });
  const trashSettingsUpdate = await fetch(`${base}/api/v1/settings/trash`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ retention_days: 45 }),
  });
  assert.deepEqual(await trashSettingsUpdate.json(), { retention_days: 45, min_days: 1, max_days: 365, purged_entries: 0 });
  assert.equal((await fetch(`${base}/api/v1/settings/trash`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ retention_days: 0 }),
  })).status, 400);
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

  const reference = `volt://${entry.id}/1`;
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
  const rotatedToken = "rotated-kernel-machine-token-at-least-32-characters";
  const rotated = await fetch(`${base}/api/v1/settings/kernel-access`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ token: rotatedToken }),
  });
  const rotatedStatus = await rotated.json();
  assert.equal(rotatedStatus.configured, true);
  assert.equal(rotatedStatus.url, "http://127.0.0.1:1");
  assert.equal((await fetch(`${base}/api/v1/internal/kernel/resolve`, {
    method: "POST",
    headers: { authorization: "Bearer kernel-machine-token-at-least-32-characters", "content-type": "application/json" },
    body: JSON.stringify({ references: [reference] }),
  })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/internal/kernel/resolve`, {
    method: "POST",
    headers: { authorization: `Bearer ${rotatedToken}`, "content-type": "application/json" },
    body: JSON.stringify({ references: [reference] }),
  })).status, 200);
  const postResolveAudit = await fetch(`${base}/api/v1/audit`, { headers: { cookie } });
  assert.equal((await postResolveAudit.text()).includes(secret), false);
  const logsArchive = await fetch(`${base}/api/v1/logs/archive`, { headers: { cookie } });
  assert.equal(logsArchive.status, 200);
  assert.equal(logsArchive.headers.get("content-type"), "application/zip");
  assert.match(logsArchive.headers.get("content-disposition"), /volt-logs-\d{4}-\d{2}-\d{2}T/);
  assert.ok((await logsArchive.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(`${base}/api/v1/service/resolve`, { method: "POST", headers: { cookie } })).status, 404);
  const wrongCurrentKey = await fetch(`${base}/api/v1/settings/access-key`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ current_access_key: "wrong current key", new_access_key: "new correct horse battery staple" }),
  });
  assert.equal(wrongCurrentKey.status, 403);
  const changedKey = await fetch(`${base}/api/v1/settings/access-key`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ current_access_key: "correct horse battery staple", new_access_key: "new correct horse battery staple" }),
  });
  assert.equal(changedKey.status, 204);
  assert.equal((await (await fetch(`${base}/api/v1/session`, { headers: { cookie } })).json()).authenticated, false);
  assert.equal((await fetch(`${base}/api/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_key: "new correct horse battery staple" }),
  })).status, 200);
});
