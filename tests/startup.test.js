import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPortableVault } from "../server/vault-file.js";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntilLive(base, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Volt exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/health/live`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Volt did not become live before the test deadline");
}

test("a stale startup key degrades to locked mode and the current Access Key unlocks without server edits", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-stale-startup-key-"));
  const filename = path.join(directory, "personal.volt");
  const accessKeyFilename = path.join(directory, "volt-access.key");
  const currentAccessKey = "current key stored by personal.volt";
  createPortableVault({ filename, accessKey: currentAccessKey }).masterKey.fill(0);
  writeFileSync(accessKeyFilename, "stale key from before rotation");
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      VOLT_ACCESS_KEY: "",
      VOLT_ACCESS_KEY_FILE: accessKeyFilename,
      VOLT_DEVICE_KEY_FILE: "",
      VOLT_MASTER_KEY_FILE: "",
      VOLT_LEGACY_MASTER_KEY_FILE: "",
      VOLT_KERNEL_TOKEN_FILE: "",
      UPDATER_CONTROL_TOKEN_FILE: "",
      VOLT_DATA_DIR: directory,
      VOLT_VAULT_FILE: filename,
      VOLT_LISTEN_HOST: "127.0.0.1",
      VOLT_PORT: String(port),
      VOLT_SECURE_COOKIES: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    await waitUntilLive(base, child);
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 503);
    const unlocked = await fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ access_key: currentAccessKey }),
    });
    assert.equal(unlocked.status, 200);
    const ready = await fetch(`${base}/api/v1/health`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    assert.equal(readFileSync(accessKeyFilename, "utf8"), currentAccessKey);
    assert.match(output.join(""), /Volt will start locked/);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
