import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { createLockedRuntime } from "../server/locked-runtime.js";
import { createApp } from "../server/app.js";
import { createPortableVault, unlockPortableVault } from "../server/vault-file.js";
import { deriveSessionKey } from "../server/crypto.js";
import { VoltStore } from "../server/store.js";

test("cold runtime stays locked with a device key and opens only after a valid operator Access Key", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "volt-locked-"));
  const filename = path.join(directory, "personal.volt");
  const key = "synthetic-runtime-access-key";
  const deviceKey = randomBytes(32);
  createPortableVault({ filename, accessKey: key, deviceKey }).masterKey.fill(0);
  let store;
  const app = createLockedRuntime({ unlock: accessKey => {
    const vault = unlockPortableVault({ filename, accessKey, deviceKey });
    store = new VoltStore({ filename, masterKey: vault.masterKey });
    return createApp({ store, sessionKey: deriveSessionKey(vault.masterKey), accessKey });
  } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = value => fetch(base + "/api/v1/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ access_key: value }) });
  try {
    assert.equal((await fetch(base + "/api/v1/health")).status, 503);
    assert.equal((await fetch(base + "/health/live")).status, 200);
    assert.equal((await fetch(base + "/api/v1/session").then(r => r.json())).locked, true);
    assert.equal((await fetch(base + "/unknown-probe")).status, 404);
    assert.equal((await login("incorrect-runtime-key")).status, 401);
    assert.equal(store, undefined);
    const response = await login(key);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    assert.equal((await response.json()).authenticated, true);
    assert.equal((await fetch(base + "/api/v1/health")).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
