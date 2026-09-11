import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

function request(socketPath, token, route, body, timeout, method = "POST") {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const call = http.request({
      socketPath,
      path: route,
      method,
      timeout,
      headers: { Host: "updater.local", Accept: "application/json", ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}), ...(token ? { "X-Updater-Token": token } : {}) },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 1024 * 1024) response.destroy(new Error("Updater response exceeds 1 MB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        let result = {};
        try { result = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch { reject(Object.assign(new Error("Updater returned invalid JSON"), { status: 502 })); return; }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(Object.assign(new Error(result.error || `Updater returned HTTP ${response.statusCode}`), { status: response.statusCode === 409 ? 409 : 502 }));
          return;
        }
        resolve(result);
      });
    });
    call.on("timeout", () => call.destroy(new Error("Updater request timed out")));
    call.on("error", (error) => {
      const unavailable = ["ENOENT", "ECONNREFUSED", "EACCES"].includes(error?.code);
      reject(Object.assign(new Error(unavailable ? "Updater is not installed or is unavailable on this VPS" : error.message), { status: unavailable ? 503 : 502 }));
    });
    if (payload) call.write(payload);
    call.end();
  });
}

export function createUpdaterClient({ socketPath, controlToken, headId }) {
  return {
    status: () => request(socketPath, "", "/v1/health", null, 3_000, "GET"),
    createUpdate: (version, filename, backup) => {
      const checksum = createHash("sha256").update(backup).digest("hex");
      const requestId = createHash("sha256").update(`${headId}:${version}:${checksum}`).digest("hex");
      return request(socketPath, controlToken, "/v1/updates", {
        request_id: requestId,
        head_id: headId,
        service: "volt",
        version,
        backup: {
          filename,
          sha256: checksum,
          data_base64: backup.toString("base64"),
          restore_url: "/api/v1/internal/updater/restore",
        },
      }, 30_000);
    },
    job: (jobId) => request(socketPath, controlToken, `/v1/jobs/${encodeURIComponent(jobId)}`, null, 5_000, "GET"),
    selfUpdate: () => request(socketPath, controlToken, "/v1/lifecycle/updater-self-update", { head_id: headId }, 30_000),
    rollback: (jobId) => request(socketPath, controlToken, `/v1/jobs/${encodeURIComponent(jobId)}/rollback`, null, 30_000),
    checkNeptune: (currentVersion) => request(socketPath, controlToken, "/v1/components/neptune-linux/check", { head_id: headId, current_version: currentVersion }, 30_000),
    updateNeptune: (version) => request(socketPath, controlToken, "/v1/components/neptune-linux/update", { head_id: headId, version }, 300_000),
    initializeNeptune: (enrollmentCode, exportUrl) => request(socketPath, controlToken, "/v1/components/neptune-linux/initialize", {
      request_id: randomUUID(), head_id: headId, project_id: "volt", export_url: exportUrl, enrollment_code: enrollmentCode,
    }, 30_000),
    neptuneInitialization: (jobId) => request(socketPath, controlToken, `/v1/components/neptune-linux/initializations/${encodeURIComponent(jobId)}?head_id=${encodeURIComponent(headId)}`, null, 5_000, "GET"),
  };
}
