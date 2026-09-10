import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUpdaterClient } from "../server/updater-client.js";

test("Updater client uses the authenticated Volt head contract over a Unix socket", { skip: process.platform === "win32" }, async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-updater-client-"));
  const socketPath = path.join(directory, "updater.sock");
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/health") response.end(JSON.stringify({ status: "ok", version: "0.3.0" }));
    else if (request.url === "/v1/updates") response.writeHead(202).end(JSON.stringify({ id: "job-1", state: "REQUESTED" }));
    else if (request.url === "/v1/jobs/job-1") response.end(JSON.stringify({ id: "job-1", state: "COMPLETED" }));
    else if (request.url === "/v1/jobs/job-1/rollback") response.writeHead(202).end(JSON.stringify({ id: "job-1", state: "ROLLING_BACK" }));
    else response.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  const client = createUpdaterClient({ socketPath, controlToken: "volt-control-token", headId: "volt" });
  assert.equal((await client.status()).version, "0.3.0");
  const backup = Buffer.from("encrypted-backup-fixture");
  assert.equal((await client.createUpdate("0.2.0", "volt-backup.zip", backup)).state, "REQUESTED");
  assert.equal((await client.job("job-1")).state, "COMPLETED");
  assert.equal((await client.rollback("job-1")).state, "ROLLING_BACK");

  const update = requests.find((item) => item.url === "/v1/updates");
  assert.equal(update.headers.host, "updater.local");
  assert.equal(update.headers["x-updater-token"], "volt-control-token");
  assert.equal(update.body.head_id, "volt");
  assert.equal(update.body.service, "volt");
  assert.equal(update.body.version, "0.2.0");
  assert.equal(update.body.backup.sha256, createHash("sha256").update(backup).digest("hex"));
  assert.equal(Buffer.from(update.body.backup.data_base64, "base64").toString(), backup.toString());
  assert.equal(requests.find((item) => item.url === "/v1/jobs/job-1/rollback").headers["x-updater-token"], "volt-control-token");
});
