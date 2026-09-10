import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import cookieParser from "cookie-parser";
import express from "express";
import { strToU8, zipSync } from "fflate";
import multer from "multer";

import { buildBackupArchive, MAX_COMPRESSED_BYTES, parseBackupArchive } from "./backup.js";
import { generateValue } from "./generators.js";
import { checkRegisteredRelease } from "./release-client.js";
import {
  createSessionToken,
  hashAccessKey,
  verifyAccessKey,
  verifySessionToken,
} from "./security.js";
import { domainError, MAX_TRASH_RETENTION_DAYS, MIN_TRASH_RETENTION_DAYS } from "./store.js";
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

function validKernelToken(value) {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 512
    && !/(?:replace-with|change-this|example-token)/i.test(value);
}

function kernelTokenHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeKernelUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function probeKernel(url) {
  try {
    const response = await fetch(`${url}/api/v1/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
    const body = await response.json().catch(() => ({}));
    const reachable = response.ok && body?.status === "ok";
    return {
      reachable,
      identity: reachable ? String(body.service ?? body.schema ?? "kernel") : null,
      checked_at: new Date().toISOString(),
      error: reachable ? null : `Kernel returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      identity: null,
      checked_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Kernel is unavailable",
    };
  }
}

export function createApp({
  store,
  sessionKey,
  accessKey,
  kernelToken,
  kernelUrlSeed = "http://127.0.0.1:18180",
  kernelServiceUrl = "",
  kernelServiceToken = "",
  appVersion = "0.1.0",
  secureCookies = false,
  trustProxy = false,
  distDir = null,
  neptuneClient = null,
  updaterClient = null,
  updaterControlToken = "",
  neptuneExportTokenFile = null,
  neptuneExportUrl = "http://127.0.0.1:18184/api/v1/internal/neptune/backup",
  releaseFetch = globalThis.fetch,
  updateCheckTimeoutMs = 5_000,
}) {
  const app = express();
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", trustProxy);

  if (!store.getSetting("access_key_hash")) store.setSetting("access_key_hash", hashAccessKey(accessKey));
  if (!store.getSetting("kernel_token_hash") && validKernelToken(kernelToken)) {
    store.setSetting("kernel_token_hash", kernelTokenHash(kernelToken));
    store.audit({ actor: "system:migration", action: "kernel_access.configure" });
  }
  if (!store.getSetting("kernel_url")) {
    const kernelUrl = normalizeKernelUrl(kernelUrlSeed);
    if (kernelUrl) store.setSetting("kernel_url", kernelUrl);
  }

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
    const configuredHash = store.getSetting("kernel_token_hash") ?? "";
    const suppliedHash = createHash("sha256").update(supplied).digest();
    const expectedHash = /^[a-f0-9]{64}$/i.test(configuredHash)
      ? Buffer.from(configuredHash, "hex")
      : Buffer.alloc(0);
    if (!supplied || expectedHash.length !== suppliedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
      return next(domainError(401, "KERNEL_UNAUTHORIZED", "A valid Kernel token is required"));
    }
    next();
  }

  function requireUpdater(request, _response, next) {
    const supplied = request.get("X-Updater-Token") ?? "";
    const expected = updaterControlToken ?? "";
    const authorized = supplied.length === expected.length
      && supplied.length > 0
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!authorized) return next(domainError(401, "UPDATER_UNAUTHORIZED", "A valid Updater token is required"));
    next();
  }

  const checkRelease = (service, currentVersion) => checkRegisteredRelease({
    kernelUrl: kernelServiceUrl,
    kernelServiceToken,
    service,
    currentVersion,
    version: appVersion,
    fetchImpl: releaseFetch,
    timeoutMs: updateCheckTimeoutMs,
  });

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
      response.json({ authenticated: true, appearance: "dark", interface: store.getInterfaceSettings() });
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
    response.json({ authenticated, appearance: "dark", interface: store.getInterfaceSettings() });
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

  app.post("/api/v1/internal/neptune/mirror", (request, response, next) => {
    try {
      if (!neptuneExportTokenFile) throw domainError(503, "NEPTUNE_NOT_CONFIGURED", "Neptune export token is not configured");
      let expected;
      try { expected = readFileSync(neptuneExportTokenFile, "utf8").trim(); }
      catch { throw domainError(503, "NEPTUNE_NOT_CONFIGURED", "Neptune export token is unavailable"); }
      const supplied = bearerToken(request) ?? "";
      const authorized = supplied.length === expected.length && supplied.length > 0 && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (!authorized) throw domainError(401, "NEPTUNE_UNAUTHORIZED", "Invalid Neptune export token");
      const snapshot = store.createPortableSnapshot();
      store.audit({ actor: "service:neptune", action: "mirror.export", target: "personal.volt" });
      response.set({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(snapshot.byteLength),
        "Content-Disposition": 'attachment; filename="personal.volt"',
        "Cache-Control": "no-store",
      });
      response.send(Buffer.from(snapshot));
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

  app.post("/api/v1/internal/updater/restore", requireUpdater, backupUpload.single("file"), (request, response, next) => {
    try {
      if (!request.file) throw domainError(400, "BACKUP_REQUIRED", "Updater did not provide a Volt backup ZIP");
      const inspected = parseBackupArchive(request.file.buffer);
      const result = store.importLogicalState(inspected.state, { actor: "service:updater", archiveDigest: inspected.digest });
      response.json({ restored: true, ...result });
    } catch (error) { next(error); }
  });

  app.use("/api/v1", requireOperator);

  app.get("/api/v1/overview", (_request, response) => {
    response.json({ ...store.getStats(), appearance: "dark", interface: store.getInterfaceSettings() });
  });

  app.get("/api/v1/dashboard", (_request, response) => response.json(store.getDashboardStats()));

  app.get("/api/v1/entries", (_request, response) => response.json({ entries: store.listEntries() }));
  app.get("/api/v1/trash", (_request, response) => response.json({
    entries: store.listDeletedEntries(),
    retention_days: store.getTrashRetentionDays(),
  }));
  app.post("/api/v1/trash/:entryId/restore", requireSameOrigin, (request, response, next) => {
    try { response.json(store.restoreDeletedEntry(request.params.entryId)); } catch (error) { next(error); }
  });
  app.delete("/api/v1/trash/:entryId", requireSameOrigin, (request, response, next) => {
    try { store.purgeEntry(request.params.entryId); response.status(204).end(); } catch (error) { next(error); }
  });
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
    try { response.json(await generateValue(request.body)); } catch (error) { next(error); }
  });

  app.get("/api/v1/audit", (request, response) => response.json({ events: store.listAudit(request.query.limit) }));
  app.get("/api/v1/logs/archive", (_request, response, next) => {
    try {
      store.audit({ actor: "operator", action: "logs.export" });
      const events = store.listAudit(500).reverse();
      const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      const archive = Buffer.from(zipSync({
        "volt-audit.jsonl": strToU8(jsonl),
        "README.txt": strToU8("Redacted Volt operator and machine audit events. Secret values are never included.\n"),
      }, { level: 9 }));
      response.set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="volt-logs-${new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")}.zip"`,
        "Content-Length": String(archive.byteLength),
      });
      response.send(archive);
    } catch (error) { next(error); }
  });
  app.get("/api/v1/update/status", async (_request, response) => {
    let updater = { reachable: false, version: null, error: "Local Updater is not configured" };
    if (updaterClient) {
      try {
        const status = await updaterClient.status();
        updater = { reachable: true, version: status.version ?? null, error: null };
      } catch (error) {
        updater = { reachable: false, version: null, error: error instanceof Error ? error.message : "Local Updater is unavailable" };
      }
    }
    response.json({
      installed_version: appVersion,
      mechanism: "Local Updater / Kernel approved release registry",
      updater,
    });
  });
  app.post("/api/v1/update/check", requireSameOrigin, async (_request, response, next) => {
    try {
      const result = await checkRelease("volt", appVersion);
      store.audit({ actor: "operator", action: "updater.check", target: result.available_version ?? appVersion, details: { update_available: result.update_available } });
      response.json(result);
    } catch (error) {
      store.audit({ actor: "operator", action: "updater.check", status: "error", details: { code: error.code ?? "RELEASE_DISCOVERY_FAILED" } });
      next(error);
    }
  });
  app.post("/api/v1/update/updater/check", requireSameOrigin, async (_request, response, next) => {
    try {
      if (!updaterClient) throw domainError(503, "UPDATER_NOT_CONFIGURED", "Updater is not configured");
      const status = await updaterClient.status();
      if (!status.version) throw domainError(503, "UPDATER_UNAVAILABLE", "Updater did not report its installed version");
      response.json(await checkRelease("updater", status.version));
    } catch (error) { next(error); }
  });
  app.post("/api/v1/update/install", requireSameOrigin, async (request, response, next) => {
    try {
      if (!updaterClient) throw domainError(503, "UPDATER_NOT_CONFIGURED", "Updater is not configured");
      const version = String(request.body?.version ?? "");
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw domainError(400, "RELEASE_VERSION_INVALID", "Select a valid Volt release version");
      const candidate = await checkRelease("volt", appVersion);
      if (!candidate.update_available || candidate.available_version !== version) {
        throw domainError(409, "RELEASE_CHANGED", "Requested Volt version is not the current upgrade candidate");
      }
      const backup = Buffer.from(buildBackupArchive(store.exportLogicalState(), appVersion));
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      const job = await updaterClient.createUpdate(version, `volt-pre-update-${stamp}.zip`, backup);
      store.audit({ actor: "operator", action: "updater.install", target: version, details: { job_id: job.id ?? null } });
      response.status(202).json(job);
    } catch (error) { next(error); }
  });
  app.get("/api/v1/update/jobs/:jobId", async (request, response, next) => {
    try {
      if (!updaterClient) throw domainError(503, "UPDATER_NOT_CONFIGURED", "Updater is not configured");
      const jobId = String(request.params.jobId ?? "");
      if (!/^[A-Za-z0-9-]{1,80}$/.test(jobId)) throw domainError(400, "UPDATE_JOB_INVALID", "Update job ID is invalid");
      response.json(await updaterClient.job(jobId));
    } catch (error) { next(error); }
  });
  app.post("/api/v1/update/jobs/:jobId/rollback", requireSameOrigin, async (request, response, next) => {
    try {
      if (!updaterClient) throw domainError(503, "UPDATER_NOT_CONFIGURED", "Updater is not configured");
      const jobId = String(request.params.jobId ?? "");
      if (!/^[A-Za-z0-9-]{1,80}$/.test(jobId)) throw domainError(400, "UPDATE_JOB_INVALID", "Update job ID is invalid");
      response.status(202).json(await updaterClient.rollback(jobId));
    } catch (error) { next(error); }
  });
  app.get("/api/v1/settings/interface", (_request, response) => response.json(store.getInterfaceSettings()));
  app.put("/api/v1/settings/interface", requireSameOrigin, (request, response, next) => {
    try {
      const settings = store.setInterfaceSettings(request.body ?? {});
      store.audit({ actor: "operator", action: "interface.change", details: { fields: Object.keys(request.body ?? {}).sort() } });
      response.json(settings);
    } catch (error) { next(error); }
  });
  app.get("/api/v1/settings/trash", (_request, response) => response.json({
    retention_days: store.getTrashRetentionDays(),
    min_days: MIN_TRASH_RETENTION_DAYS,
    max_days: MAX_TRASH_RETENTION_DAYS,
  }));
  app.put("/api/v1/settings/trash", requireSameOrigin, (request, response, next) => {
    try {
      const retentionDays = store.setTrashRetentionDays(request.body?.retention_days);
      const purgedEntries = store.purgeExpiredEntries({ actor: "operator" });
      response.json({
        retention_days: retentionDays,
        min_days: MIN_TRASH_RETENTION_DAYS,
        max_days: MAX_TRASH_RETENTION_DAYS,
        purged_entries: purgedEntries,
      });
    } catch (error) { next(error); }
  });
  app.put("/api/v1/settings/appearance", requireSameOrigin, (request, response) => {
    store.setAppearance("dark");
    response.json({ appearance: "dark", interface: store.getInterfaceSettings() });
  });
  app.put("/api/v1/settings/access-key", requireSameOrigin, (request, response, next) => {
    try {
      const currentAccessKey = request.body?.current_access_key;
      const accessKey = request.body?.new_access_key;
      if (!verifyAccessKey(String(currentAccessKey ?? ""), store.getSetting("access_key_hash"))) {
        throw domainError(403, "CURRENT_ACCESS_KEY_INVALID", "Current Access Key is incorrect");
      }
      if (typeof accessKey !== "string" || accessKey.length < 12 || accessKey.length > 512) {
        throw domainError(400, "WEAK_ACCESS_KEY", "Access Key must contain between 12 and 512 characters");
      }
      store.rotateAccessKey(accessKey, hashAccessKey(accessKey));
      response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: secureCookies, path: "/" });
      store.audit({ actor: "operator", action: "access_key.change" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/v1/settings/kernel-access", async (_request, response) => {
    const url = store.getSetting("kernel_url") ?? "http://127.0.0.1:18180";
    response.json({
      configured: Boolean(store.getSetting("kernel_token_hash")),
      url,
      ...(await probeKernel(url)),
    });
  });
  app.put("/api/v1/settings/kernel-access", requireSameOrigin, (request, response, next) => {
    Promise.resolve().then(async () => {
      const token = request.body?.token;
      const requestedUrl = request.body?.url;
      if (token !== undefined && !validKernelToken(token)) {
        throw domainError(400, "INVALID_KERNEL_TOKEN", "Kernel token must contain between 32 and 512 non-placeholder characters");
      }
      let url = store.getSetting("kernel_url") ?? "http://127.0.0.1:18180";
      if (requestedUrl !== undefined) {
        const normalized = normalizeKernelUrl(requestedUrl);
        if (!normalized) throw domainError(400, "KERNEL_URL_INVALID", "Kernel URL must be an HTTP(S) authority without credentials, path, query or fragment");
        const status = await probeKernel(normalized);
        if (!status.reachable) throw domainError(409, "KERNEL_UNREACHABLE", "The new Kernel URL did not return a healthy Kernel response");
        url = normalized;
      }
      if (requestedUrl === undefined && token === undefined) {
        throw domainError(400, "KERNEL_SETTINGS_EMPTY", "Provide a Kernel URL or replacement token");
      }
      if (requestedUrl !== undefined) store.setSetting("kernel_url", url);
      if (token !== undefined) store.setSetting("kernel_token_hash", kernelTokenHash(token));
      store.audit({ actor: "operator", action: token !== undefined ? "kernel_access.rotate" : "kernel_url.change" });
      response.json({
        configured: Boolean(store.getSetting("kernel_token_hash")),
        url,
        ...(await probeKernel(url)),
      });
    }).catch(next);
  });

  app.get("/api/v1/neptune/status", async (_request, response, next) => {
    try {
      if (!neptuneClient) throw domainError(503, "NEPTUNE_NOT_CONFIGURED", "Neptune is not configured");
      response.json(await neptuneClient.status());
    } catch (error) { next(error); }
  });
  app.get("/api/v1/neptune/availability", async (_request, response, next) => {
    try { response.json(await neptuneClient.availability()); } catch (error) { next(error); }
  });
  app.post("/api/v1/neptune/initialize", requireSameOrigin, async (request, response, next) => {
    try {
      const code = String(request.body?.enrollment_code ?? "").trim();
      if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw domainError(400, "NEPTUNE_CODE_INVALID", "Enter a valid 32-character Saturn setup code");
      if (!updaterClient) throw domainError(503, "UPDATER_NOT_CONFIGURED", "Updater is not configured");
      const job = await updaterClient.initializeNeptune(code, neptuneExportUrl);
      store.audit({ actor: "operator", action: "neptune.initialize", target: String(job.id ?? "accepted") });
      response.status(202).json(job);
    } catch (error) { next(error); }
  });
  app.get("/api/v1/neptune/initializations/:jobId", async (request, response, next) => {
    try {
      if (!updaterClient) throw domainError(503, "UPDATER_NOT_CONFIGURED", "Updater is not configured");
      const jobId = String(request.params.jobId ?? "");
      if (!/^neptune-[0-9]+-[a-f0-9]{16}$/.test(jobId)) throw domainError(400, "NEPTUNE_JOB_INVALID", "Neptune initialization job ID is invalid");
      response.json(await updaterClient.neptuneInitialization(jobId));
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
