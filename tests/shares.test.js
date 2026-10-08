import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { deriveSessionKey } from "../server/crypto.js";
import { ShareService } from "../server/shares.js";
import { VoltStore } from "../server/store.js";

test("Shares expose only selected snapshot fields and enforce password, policy and revocation", async context => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-share-test-"));
  const masterKey = randomBytes(32);
  const store = new VoltStore({ filename: path.join(directory, "personal.volt"), masterKey });
  const distDir = path.join(directory, "dist");
  mkdirSync(distDir);
  writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>Volt Share</title>");
  const app = createApp({ store, sessionKey: deriveSessionKey(masterKey), accessKey: "owner-access-key", secureCookies: false, distDir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const json = async response => ({ status: response.status, body: await response.json() });
  const ownerLogin = await fetch(`${base}/api/v1/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ access_key: "owner-access-key" }) });
  const ownerCookie = ownerLogin.headers.getSetCookie()[0].split(";")[0];
  const ownerHeaders = { cookie: ownerCookie, origin: base, "content-type": "application/json" };
  const created = await json(await fetch(`${base}/api/v1/entries`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ title: "Account", fields: [
    { key: "login", value: "alice@example.test", visibility: "plain" },
    { key: "password", value: "first-secret", visibility: "secret" },
    { key: "private-token", value: "never-share", visibility: "secret" },
  ] }) }));
  assert.equal(created.status, 201);
  const entry = created.body;
  const share = await json(await fetch(`${base}/api/v1/shares`, { method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ entry_id: entry.id, expected_revision: entry.revision, field_ids: entry.fields.slice(0, 2).map(field => field.id), password: "separate-channel", expires_at: new Date(Date.now() + 86_400_000).toISOString() }) }));
  assert.equal(share.status, 201);
  assert.match(share.body.path, /^\/share\/[0-9a-f-]+#[A-Za-z0-9_-]{43}$/);
  const publicPage = await fetch(base + share.body.path);
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /Volt Share/);
  assert.equal(publicPage.headers.get("cache-control"), "no-store, max-age=0");
  const { id } = share.body, token = share.body.path.split("#")[1];
  const persistedShare = JSON.stringify(store.db.prepare("SELECT * FROM shares WHERE id = ?").get(id));
  assert.equal(persistedShare.includes(token), false);
  assert.equal(persistedShare.includes("separate-channel"), false);
  const publicPolicy = await json(await fetch(`${base}/public/shares/${id}/policy`));
  assert.equal(publicPolicy.status, 200);
  assert.equal(publicPolicy.body.password_required, true);
  assert.ok(Date.parse(publicPolicy.body.expires_at) > Date.now());
  assert.equal(JSON.stringify(publicPolicy.body).includes("first-secret"), false);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/entry`, { headers: { cookie: ownerCookie } }))).status, 401);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/entry?legacy=1`))).status, 401);
  const copied = await json(await fetch(`${base}/api/v1/shares/${id}/link`, { headers: { cookie: ownerCookie } }));
  assert.equal(copied.body.path, share.body.path);
  const copiedAgain = await json(await fetch(`${base}/api/v1/shares/${id}/link`, { headers: { cookie: ownerCookie } }));
  assert.equal(copiedAgain.body.path, share.body.path);
  assert.equal((await json(await fetch(`${base}/api/v1/shares`))).status, 401);
  const listing = await json(await fetch(`${base}/api/v1/shares`, { headers: { cookie: ownerCookie } }));
  assert.equal(listing.body.shares[0].field_count, 2);
  assert.equal(JSON.stringify(listing.body).includes("first-secret"), false);
  assert.equal(JSON.stringify(listing.body).includes("never-share"), false);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/entry`))).status, 401);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/session`, { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ token, password: "separate-channel" }) }))).status, 403);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token, password: "wrong" }) }))).status, 401);
  const unlocked = await fetch(`${base}/public/shares/${id}/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token, password: "separate-channel" }) });
  assert.equal(unlocked.status, 200);
  const visitorCookie = unlocked.headers.getSetCookie()[0].split(";")[0];
  const secondBrowser = await fetch(`${base}/public/shares/${id}/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token, password: "separate-channel" }) });
  assert.equal(secondBrowser.status, 200);
  const secondBrowserCookie = secondBrowser.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/entry`, { headers: { cookie: secondBrowserCookie } }))).status, 200);
  const viewed = await json(await fetch(`${base}/public/shares/${id}/entry`, { headers: { cookie: visitorCookie } }));
  assert.equal(viewed.status, 200);
  assert.equal(viewed.body.title, "Account");
  assert.deepEqual(viewed.body.fields.map(field => field.key), ["login", "password"]);
  assert.equal(viewed.body.fields[0].value, "alice@example.test");
  assert.equal(viewed.body.fields[1].value, null);
  assert.equal(JSON.stringify(viewed.body).includes("never-share"), false);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/fields/${entry.fields[2].id}/reveal`, { method: "POST", headers: { origin: base, cookie: visitorCookie, "content-type": "application/json" }, body: "{}" }))).status, 404);
  const revealed = await json(await fetch(`${base}/public/shares/${id}/fields/${entry.fields[1].id}/reveal`, { method: "POST", headers: { origin: base, cookie: visitorCookie, "content-type": "application/json" }, body: "{}" }));
  assert.equal(revealed.body.value, "first-secret");
  assert.equal((await json(await fetch(`${base}/api/v1/entries`, { headers: { cookie: visitorCookie } }))).status, 401);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/entry`, { method: "PUT", headers: { cookie: visitorCookie } }))).status, 404);

  const changed = await json(await fetch(`${base}/api/v1/entries/${entry.id}`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ title: "Account", expected_revision: 1, fields: [
    { id: entry.fields[0].id, key: "login", value: "alice@example.test", visibility: "plain" },
    { id: entry.fields[1].id, key: "password", value: "new-secret", visibility: "secret" },
    { id: entry.fields[2].id, key: "private-token", value: "never-share", visibility: "secret" },
  ] }) }));
  assert.equal(changed.status, 200);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/fields/${entry.fields[1].id}/reveal`, { method: "POST", headers: { origin: base, cookie: visitorCookie, "content-type": "application/json" }, body: "{}" }))).body.value, "first-secret");
  assert.equal((await json(await fetch(`${base}/api/v1/shares`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ entry_id: entry.id, expected_revision: 1, field_ids: [entry.fields[1].id] }) }))).status, 409);
  assert.equal((await json(await fetch(`${base}/api/v1/shares/${id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ password: "changed-password" }) }))).status, 200);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/entry`, { headers: { cookie: visitorCookie } }))).status, 401);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token, password: "separate-channel" }) }))).status, 401);
  assert.equal((await json(await fetch(`${base}/api/v1/shares/${id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ revoke: true }) }))).status, 200);
  assert.equal((await json(await fetch(`${base}/public/shares/${id}/policy`))).status, 404);
  assert.equal((await json(await fetch(`${base}/api/v1/shares/${id}/link`, { headers: { cookie: ownerCookie } }))).status, 404);
});

test("deleting an entry revokes its Share and logical restore does not recover links", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-share-restore-"));
  const masterKey = randomBytes(32);
  const store = new VoltStore({ filename: path.join(directory, "personal.volt"), masterKey });
  try {
    const entry = store.createEntry({ schema: 1, title: "Account", fields: [{ id: randomUUID(), key: "password", value: "secret", visibility: "secret" }] });
    const shares = new ShareService(store);
    const share = shares.create({ entry_id: entry.id, expected_revision: 1, field_ids: [entry.fields[0].id] });
    assert.equal(new ShareService(store).link(share.id), share.path);
    const state = store.exportLogicalState();
    store.deleteEntry(entry.id);
    store.restoreDeletedEntry(entry.id);
    assert.throws(() => shares.row(share.id), { code: "SHARE_NOT_FOUND" });
    store.importLogicalState(state);
    assert.deepEqual(shares.list(), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("expired Shares reject existing sessions and a missing instance key fails closed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-share-expiry-"));
  const masterKey = randomBytes(32), filename = path.join(directory, "personal.volt");
  const store = new VoltStore({ filename, masterKey });
  try {
    const entry = store.createEntry({ schema: 1, title: "Short-lived", fields: [{ id: randomUUID(), key: "password", value: "secret", visibility: "secret" }] });
    const service = new ShareService(store);
    const share = service.create({ entry_id: entry.id, expected_revision: 1, field_ids: [entry.fields[0].id] });
    const session = service.unlock(share.id, share.path.split("#")[1], null, "192.0.2.7");
    store.db.prepare("UPDATE shares SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), share.id);
    assert.throws(() => service.view(share.id, session.token), { code: "SHARE_NOT_FOUND" });
    rmSync(`${filename}.share-key`);
    const restarted = new ShareService(store);
    assert.throws(() => restarted.row(share.id), { code: "SHARE_NOT_FOUND" });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
