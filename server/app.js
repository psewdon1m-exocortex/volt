import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";

import { buildBackupArchive, MAX_COMPRESSED_BYTES, parseBackupArchive } from "./backup.js";
import { generateValue } from "./generators.js";
import {
  createSessionToken,
  hashAccessKey,
  verifyAccessKey,
  verifySessionToken,
} from "./security.js";
import { domainError } from "./store.js";
import { normalizeEntryPayload, normalizeReason } from "./validation.js";

const COOKIE_NAME = "volt_session";
const BLOCKED_PROBE_PATH = /(^|\/)\.|\.(?:env|ini|log|sql|bak|backup|old|swp|zip|tar|gz)$/i;

function apiError(res, error, requestId) {
  const status = error.code === "LIMIT_FILE_SIZE" ? 413 : Number(error.status) || 500;
  const code = error.code === "LIMIT_FILE_SIZE" ? "BACKUP_TOO_LARGE" : error.code || "INTERNAL_ERROR";
  if (status >= 500) console.error(`[${requestId}]`, error);
  res.status(status).json({ error: { code, message: status >= 500 ? "Volt could not complete the request" : error.message, request_id: requestId } });
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export function createApp({ store, sessionKey, accessKey, kernelToken, secureCookies = false, trustProxy = false, distDir = null, neptuneClient = null, updaterClient = null, neptuneExportTokenFile = null }) {
  const app = express();
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", trustProxy);

  if (!store.getSetting("access_key_hash")) store.setSetting("access_key_hash", hashAccessKey(accessKey));

  const loginAttempts = new Map();
  const networkActor = (address) => `network:${createHmac("sha256", sessionKey).update(String(address)).digest("hex").slice(0, 20)}`;
  function pruneLoginAttempts(now) {
    if (loginAttempts.size < 2_048) return;
    for (const [address, attempt] of loginAttempts) {
      if (attempt.blockedUntil <= now && attempt.lastAttempt < now - 5 * 60_000) loginAttempts.delete(address);
    }
    while (loginAttempts.size >= 2_048) loginAttempts.delete(loginAttempts.keys().next().value);
  }
  const backupUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: MAX_COMPRESSED_BYTES } });

  app.use((request, response, next) => {
    request.requestId = randomUUID();
    response.setHeader("X-Request-ID", request.requestId);
    response.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
    });
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
    );
    next();
  });
  app.use((request, response, next) => {
    if (BLOCKED_PROBE_PATH.test(request.path)) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
    next();
  });
  app.use(express.json({ limit: "2mb", type: "application/json" }));
  app.use(cookieParser());

  function requireSameOrigin(request, _response, next) {
    const origin = request.get("origin");
    if (origin) {
      try {
        const expectedOrigin = `${request.protocol}://${request.get("host")}`;
        if (new URL(origin).origin !== expectedOrigin) {
          throw domainError(403, "ORIGIN_REJECTED", "Cross-origin mutation rejected");
        }
      } catch (error) {
        return next(error.status ? error : domainError(403, "ORIGIN_REJECTED", "Invalid request origin"));
      }
    }
    next();
  }

  function requireOperator(request, _response, next) {
    const token = request.cookies[COOKIE_NAME];
    const session = verifySessionToken(token, sessionKey, store.getAuthGeneration());
    if (!session) return next(domainError(401, "AUTH_REQUIRED", "Unlock Volt to continue"));
    request.actor = session.sub;
    next();
  }

  function requireKernel(request, _response, next) {
    const supplied = bearerToken(request) ?? "";
    const suppliedHash = createHash("sha256").update(supplied).digest();
    const expectedHash = createHash("sha256").update(kernelToken ?? "").digest();
    if (!kernelToken || !supplied || !timingSafeEqual(suppliedHash, expectedHash)) {
      return next(domainError(401, "KERNEL_UNAUTHORIZED", "A valid Kernel token is required"));
    }
    next();
  }

  app.get("/api/v1/health", (_request, response) => {
    response.json({ status: "ok", service: "volt", schema: "volt.health.v1" });
  });

  app.post("/api/v1/session", requireSameOrigin, (request, response, next) => {
    try {
      const ip = request.ip || request.socket.remoteAddress || "unknown";
      pruneLoginAttempts(Date.now());
      const previous = loginAttempts.get(ip) ?? { count: 0, blockedUntil: 0 };
      if (previous.blockedUntil > Date.now()) throw domainError(429, "TOO_MANY_ATTEMPTS", "Wait before trying again");
      const candidate = typeof request.body?.access_key === "string" ? request.body.access_key : "";
      if (candidate.length > 512 || !verifyAccessKey(candidate, store.getSetting("access_key_hash"))) {
        const count = previous.count + 1;
        loginAttempts.set(ip, { count, blockedUntil: count >= 5 ? Date.now() + 60_000 : 0, lastAttempt: Date.now() });
        store.audit({ actor: networkActor(ip), action: "session.unlock", status: "denied" });
        throw domainError(401, "INVALID_ACCESS_KEY", "Access Key is incorrect");
      }
      loginAttempts.delete(ip);
      const generation = store.getAuthGeneration();
      response.cookie(COOKIE_NAME, createSessionToken(sessionKey, generation), {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookies,
        path: "/",
        maxAge: 12 * 60 * 60 * 1000,
      });
      store.audit({ actor: "operator", action: "session.unlock" });
      response.json({ authenticated: true, appearance: store.getAppearance() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/session", (request, response) => {
    const authenticated = Boolean(verifySessionToken(
      request.cookies[COOKIE_NAME],
      sessionKey,
      store.getAuthGeneration(),
    ));
    response.json({ authenticated, appearance: store.getAppearance() });
  });

  app.delete("/api/v1/session", requireSameOrigin, (request, response) => {
    response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: secureCookies, path: "/" });
    store.audit({ actor: "operator", action: "session.lock" });
    response.status(204).end();
  });

  app.post("/api/v1/internal/neptune/backup", (request, response, next) => {
    try {
      if (!neptuneExportTokenFile) throw domainError(503, "NEPTUNE_NOT_CONFIGURED", "Neptune export token is not configured");
      let expected;
      try { expected = readFileSync(neptuneExportTokenFile, "utf8").trim(); }
      catch { throw domainError(503, "NEPTUNE_NOT_CONFIGURED", "Neptune export token is unavailable"); }
      const supplied = bearerToken(request) ?? "";
      const authorized = supplied.length === expected.length && supplied.length > 0 && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (!authorized) throw domainError(401, "NEPTUNE_UNAUTHORIZED", "Invalid Neptune export token");
      const archive = buildBackupArchive(store.exportLogicalState());
      store.audit({ actor: "service:neptune", action: "backup.export" });
      response.set({ "Content-Type": "application/zip", "Content-Length": String(archive.byteLength), "Cache-Control": "no-store" });
      response.send(Buffer.from(archive));
    } catch (error) { next(error); }
  });

  app.post("/api/v1/internal/kernel/resolve", requireKernel, (request, response, next) => {
    try {
      if (!Array.isArray(request.body?.references) || request.body.references.some((value) => typeof value !== "string")) {
        throw domainError(400, "INVALID_REFERENCE_BATCH", "references must be an array of strings");
      }
      response.json(store.resolveReferences(request.body.references));
    } catch (error) {
      store.audit({
        actor: "service:kernel",
        action: "secret.resolve",
        status: "denied",
        details: { code: error.code ?? "INTERNAL_ERROR" },
      });
      next(error);
    }
  });

  app.use("/api/v1", requireOperator);

  app.get("/api/v1/overview", (_request, response) => {
    response.json({ ...store.getStats(), appearance: store.getAppearance() });
  });

  app.get("/api/v1/entries", (_request, response) => response.json({ entries: store.listEntries() }));
  app.post("/api/v1/entries", requireSameOrigin, (request, response, next) => {
    try {
      response.status(201).json(store.createEntry(normalizeEntryPayload(request.body)));
    } catch (error) { next(error); }
  });
  app.post("/api/v1/entries/reorder", requireSameOrigin, (request, response, next) => {
    try {
      if (!Array.isArray(request.body?.ids) || request.body.ids.some((id) => typeof id !== "string")) {
        throw domainError(400, "INVALID_ENTRY_ORDER", "ids must be an array of entry identifiers");
      }
      store.reorderEntries(request.body.ids);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  app.get("/api/v1/entries/:entryId", (request, response, next) => {
    try { response.json(store.getEntry(request.params.entryId)); } catch (error) { next(error); }
  });
  app.put("/api/v1/entries/:entryId", requireSameOrigin, (request, response, next) => {
    try {
      response.json(store.updateEntry(request.params.entryId, normalizeEntryPayload(request.body), {
        expectedRevision: request.body.expected_revision,
        reason: normalizeReason(request.body.reason, "updated"),
      }));
    } catch (error) { next(error); }
  });
  app.delete("/api/v1/entries/:entryId", requireSameOrigin, (request, response, next) => {
    try { store.deleteEntry(request.params.entryId); response.status(204).end(); } catch (error) { next(error); }
  });
  app.delete("/api/v1/entries/:entryId/purge", requireSameOrigin, (request, response, next) => {
    try { store.purgeEntry(request.params.entryId); response.status(204).end(); } catch (error) { next(error); }
  });
  app.get("/api/v1/entries/:entryId/revisions", (request, response, next) => {
    try { response.json({ revisions: store.getRevisions(request.params.entryId) }); } catch (error) { next(error); }
  });
  app.get("/api/v1/entries/:entryId/revisions/:revision", (request, response, next) => {
    try { response.json(store.getRevision(request.params.entryId, Number(request.params.revision))); } catch (error) { next(error); }
  });
  app.post("/api/v1/entries/:entryId/revisions/:revision/restore", requireSameOrigin, (request, response, next) => {
    try { response.json(store.restoreRevision(request.params.entryId, Number(request.params.revision))); } catch (error) { next(error); }
  });
  app.post("/api/v1/entries/:entryId/fields/:fieldId/reveal", requireSameOrigin, (request, response, next) => {
    try {
      response.json(store.revealField(request.params.entryId, request.params.fieldId, {
        revisionNumber: request.body?.revision == null ? null : Number(request.body.revision),
      }));
    } catch (error) { next(error); }
  });

  app.post("/api/v1/generate", requireSameOrigin, async (request, response, next) => {
    try { response.json(generateValue(request.body)); } catch (error) { next(error); }
  });

  app.get("/api/v1/audit", (request, response) => response.json({ events: store.listAudit(request.query.limit) }));
  app.put("/api/v1/settings/appearance", requireSameOrigin, (request, response) => {
    response.json({ appearance: store.setAppearance(request.body?.appearance) });
  });
  app.put("/api/v1/settings/access-key", requireSameOrigin, (request, response, next) => {
    try {
      const accessKey = request.body?.access_key;
      if (typeof accessKey !== "string" || accessKey.length < 12 || accessKey.length > 512) {
        throw domainError(400, "WEAK_ACCESS_KEY", "Access Key must contain between 12 and 512 characters");
      }
      store.rotateAccessKey(accessKey, hashAccessKey(accessKey));
      response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: secureCookies, path: "/" });
      store.audit({ actor: "operator", action: "access_key.change" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/v1/neptune/status", async (_request, response, next) => {
    try {
      if (!neptuneClient) throw domainError(503, "NEPTUNE_NOT_CONFIGURED", "Neptune is not configured");
      response.json(await neptuneClient.status());
    } catch (error) { next(error); }
  });
  app.put("/api/v1/neptune/schedule", requireSameOrigin, async (request, response, next) => {
    try {
      const enabled = request.body?.enabled;
      const intervalHours = Number(request.body?.interval_hours);
      if (typeof enabled !== "boolean" || !Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 8760) {
        throw domainError(400, "NEPTUNE_INTERVAL_INVALID", "Interval must be a whole number of hours between 1 and 8760");
      }
      await neptuneClient.schedule(enabled, intervalHours);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  app.post("/api/v1/neptune/runs", requireSameOrigin, async (_request, response, next) => {
    try { response.status(202).json(await neptuneClient.run()); } catch (error) { next(error); }
  });
  app.post("/api/v1/neptune/update/check", requireSameOrigin, async (_request, response, next) => {
    try {
      const status = await neptuneClient.status();
      response.json(await updaterClient.checkNeptune(status.version));
    } catch (error) { next(error); }
  });
  app.post("/api/v1/neptune/update/install", requireSameOrigin, async (request, response, next) => {
    try {
      const requested = String(request.body?.version ?? "");
      const status = await neptuneClient.status();
      const candidate = await updaterClient.checkNeptune(status.version);
      if (!candidate.update_available || candidate.available_version !== requested) {
        throw domainError(409, "NEPTUNE_UPDATE_CHANGED", "Requested Neptune version is not the current upgrade candidate");
      }
      response.json(await updaterClient.updateNeptune(requested));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/vault-file", (_request, response, next) => {
    try {
      store.audit({ actor: "operator", action: "vault.export" });
      const vault = store.createPortableSnapshot();
      response.set({
        "Content-Type": "application/vnd.exocortex.volt",
        "Content-Disposition": "attachment; filename=\"personal.volt\"",
        "Content-Length": String(vault.byteLength),
      });
      response.send(vault);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/vault-file/info", (_request, response, next) => {
    try { response.json(store.getPortableVaultInfo()); } catch (error) { next(error); }
  });

  app.get("/api/v1/backup", (_request, response, next) => {
    try {
      store.audit({ actor: "operator", action: "backup.export" });
      const archive = buildBackupArchive(store.exportLogicalState());
      response.set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="volt-backup-${new Date().toISOString().slice(0, 10)}.zip"`,
        "Content-Length": String(archive.byteLength),
      });
      response.send(Buffer.from(archive));
    } catch (error) { next(error); }
  });
  app.post("/api/v1/backup/inspect", requireSameOrigin, backupUpload.single("file"), (request, response, next) => {
    try {
      if (!request.file) throw domainError(400, "BACKUP_REQUIRED", "Select a Volt backup ZIP");
      const inspected = parseBackupArchive(request.file.buffer);
      store.audit({ actor: "operator", action: "backup.inspect", target: inspected.digest, details: { bytes: request.file.size } });
      response.json({ digest: inspected.digest, manifest: inspected.manifest, filename: request.file.originalname, bytes: request.file.size });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/backup/restore", requireSameOrigin, backupUpload.single("file"), (request, response, next) => {
    try {
      if (!request.file) throw domainError(400, "BACKUP_REQUIRED", "Select a Volt backup ZIP");
      const inspected = parseBackupArchive(request.file.buffer);
      if (request.body?.digest !== inspected.digest) {
        throw domainError(409, "BACKUP_CHANGED", "The backup differs from the inspected archive");
      }
      const result = store.importLogicalState(inspected.state, { archiveDigest: inspected.digest });
      response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: secureCookies, path: "/" });
      response.json({ restored: true, ...result });
    } catch (error) { next(error); }
  });

  app.use("/api/v1", (request, _response, next) => {
    next(domainError(404, "NOT_FOUND", `No route for ${request.method} ${request.path}`));
  });

  app.get("/robots.txt", (_request, response) => response.type("text/plain").send("User-agent: *\nDisallow: /\n"));
  if (distDir && existsSync(distDir)) {
    app.use(express.static(distDir, { etag: false, lastModified: false, maxAge: 0 }));
    app.get("/{*path}", (_request, response) => response.sendFile(path.join(distDir, "index.html")));
  }

  app.use((request, _response, next) => next(domainError(404, "NOT_FOUND", `No route for ${request.method} ${request.path}`)));
  app.use((error, request, response, _next) => apiError(response, error, request.requestId));

  return app;
}
