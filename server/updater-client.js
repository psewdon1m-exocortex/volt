import http from "node:http";

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
    checkNeptune: (currentVersion) => request(socketPath, "", "/v1/components/neptune-linux/check", { head_id: headId, current_version: currentVersion }, 30_000),
    updateNeptune: (version) => request(socketPath, controlToken, "/v1/components/neptune-linux/update", { head_id: headId, version }, 300_000),
  };
}
