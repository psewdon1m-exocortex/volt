import express from "express";
import path from "node:path";

/** The vault is opened only after an Access Key is supplied. No device-key fallback. */
export function createLockedRuntime({ unlock, distDir, initialApp = null, trustProxy = false }) {
  const gateway = express();
  gateway.disable("x-powered-by");
  gateway.set("trust proxy", trustProxy);
  let active = initialApp;
  const attempts = new Map();
  let globalWindow = Date.now();
  let globalAttempts = 0;
  gateway.use((request, response, next) => active ? active(request, response, next) : next());
  gateway.use((_request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });
  gateway.get("/health/live", (_request, response) => response.json({ status: "ok", locked: true }));
  gateway.get("/api/v1/health", (_request, response) => response.status(503).json({ status: "locked", service: "volt", schema: "volt.health.v1" }));
  gateway.get("/api/v1/session", (_request, response) => response.json({ authenticated: false, locked: true, appearance: "dark" }));
  gateway.post("/api/v1/session", express.json({ limit: "4kb" }), (request, response, next) => {
    const fail = (status, code) => response.status(status).json({ error: { code, message: code === "INVALID_ACCESS_KEY" ? "Access Key is incorrect" : "Wait before trying again" } });
    const origin = request.get("origin");
    try {
      if (request.get("sec-fetch-site") === "cross-site" || (origin && new URL(origin).origin !== `${request.protocol}://${request.get("host")}`)) return fail(403, "ORIGIN_REJECTED");
    } catch { return fail(403, "ORIGIN_REJECTED"); }
    const now = Date.now();
    if (now - globalWindow > 60_000) { globalWindow = now; globalAttempts = 0; }
    for (const [ip, state] of attempts) if (state.until <= now) attempts.delete(ip);
    const ip = request.ip || request.socket.remoteAddress;
    const state = attempts.get(ip) || { count: 0, until: now + 60_000 };
    if (state.count >= 5 || globalAttempts >= 30) return fail(429, "TOO_MANY_ATTEMPTS");
    state.count++; globalAttempts++; attempts.set(ip, state);
    const key = request.body?.access_key;
    if (typeof key !== "string" || key.length < 12 || key.length > 512) return fail(401, "INVALID_ACCESS_KEY");
    try { active = unlock(key); }
    catch { return fail(401, "INVALID_ACCESS_KEY"); }
    attempts.clear();
    return active(request, response, next);
  });
  if (distDir) {
    gateway.use("/assets", express.static(path.join(distDir, "assets"), { index: false, dotfiles: "deny" }));
    gateway.get(["/", "/dashboard", "/vault", "/trash", "/audit", "/settings", "/docs", "/documentation"], (_request, response) => response.sendFile(path.join(distDir, "index.html")));
    gateway.get("/robots.txt", (_request, response) => response.type("text/plain").send("User-agent: *\nDisallow: /\n"));
  }
  gateway.use((_request, response) => response.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } }));
  gateway.use((error, _request, response, _next) => response.status(error.status === 413 ? 413 : 400).json({ error: { code: "INVALID_REQUEST", message: "Invalid request" } }));
  return gateway;
}
