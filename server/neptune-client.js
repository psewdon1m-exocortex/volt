import fs from "node:fs";
import http from "node:http";

function request(socketPath, projectId, token, method, route, body, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const call = http.request({
      socketPath,
      path: projectId ? `/v1/projects/${encodeURIComponent(projectId)}${route}` : route,
      method,
      timeout,
      headers: {
        Host: "neptune.local",
        Accept: "application/json",
        ...(token ? { "X-Neptune-Token": token } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
      },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 1024 * 1024) response.destroy(new Error("Neptune response exceeds 1 MB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        let result = {};
        try { result = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch { reject(Object.assign(new Error("Neptune returned invalid JSON"), { status: 502 })); return; }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(Object.assign(new Error(result.error || `Neptune returned HTTP ${response.statusCode}`), { status: response.statusCode === 409 ? 409 : 502 }));
          return;
        }
        resolve(result);
      });
    });
    call.on("timeout", () => call.destroy(new Error("Neptune request timed out")));
    call.on("error", (error) => {
      const unavailable = ["ENOENT", "ECONNREFUSED", "EACCES"].includes(error?.code);
      reject(Object.assign(new Error(unavailable ? "Neptune is not installed or is unavailable on this VPS" : error.message), { status: unavailable ? 503 : 502 }));
    });
    if (payload) call.write(payload);
    call.end();
  });
}

export function createNeptuneClient({ socketPath, projectId, controlTokenFile }) {
  function token() {
    if (!controlTokenFile) throw Object.assign(new Error("Neptune control token is not configured"), { status: 503 });
    try { return fs.readFileSync(controlTokenFile, "utf8").trim(); }
    catch { throw Object.assign(new Error("Neptune control token is unavailable"), { status: 503 }); }
  }
  return {
    async availability() {
      try {
        const health = await request(socketPath, "", "", "GET", "/v1/health", null, 3_000);
        try { return { installed: true, linked: true, state: "linked", ...(await this.status()) }; }
        catch { return { installed: true, linked: false, state: "unlinked", version: health.version ?? null }; }
      } catch { return { installed: false, linked: false, state: "unavailable", version: null }; }
    },
    status: () => request(socketPath, projectId, token(), "GET", "/status"),
    schedule: (enabled, intervalHours) => request(socketPath, projectId, token(), "PUT", "/schedule", { enabled, intervalHours }),
    run: () => request(socketPath, projectId, token(), "POST", "/runs"),
  };
}
