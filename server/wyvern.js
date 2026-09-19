import { createHash } from "node:crypto";
import { normalizeEntryPayload } from "./validation.js";
import { validateConfig } from "./wyvern-contract/config.js";
import { fields, ID, HASH, canonical } from "./wyvern-contract/util.js";

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export const credentialKey = (instance, adapter) => "wyvern.credentials." + createHash("sha256").update(instance + ":" + adapter).digest("hex");
const setting = instance => "wyvern_instance_v1:" + instance;
const payload = (title, key, value, secret) => normalizeEntryPayload({ title, projects: ["Wyvern"], fields: [{ key, value, visibility: secret ? "secret" : "plain" }] });

export function inspectWyvern(store, instance) {
  if (!ID.test(instance)) fail(400, "WYVERN_REQUEST_INVALID");
  const saved = JSON.parse(store.getSetting(setting(instance)) || "null");
  if (!saved) return { schema: "exocortex.volt.wyvern.v1", instance_id: instance, revision: 0, references: {} };
  const config = store.getEntry(saved.config_id);
  const references = { ["wyvern.instances." + instance + ".config"]: `volt://${saved.config_id}/1` };
  for (const [id, entry] of Object.entries(saved.credentials)) references[credentialKey(instance, id)] = `volt://${entry}/1`;
  return { schema: "exocortex.volt.wyvern.v1", instance_id: instance, revision: config.revision, references,
    ...(config.fields?.some(field => field.key === "repository") ? { repository_ref: `volt://${saved.config_id}/2` } : {}),
    last_request_id: saved.request_id, last_request_hash: saved.request_hash, last_operation_hash: saved.operation_hash };
}

// All values and their journal metadata commit in one SQLite transaction.
// Retrying the last request after a lost response returns its original revision.
export function publishWyvern(store, input) {
  try { fields(input, ["instance_id", "expected_revision", "config", "credentials", "request_id", "operation_hash"], ["instance_id", "expected_revision", "config", "credentials", "request_id"]); }
  catch { fail(400, "WYVERN_REQUEST_INVALID"); }
  if (!ID.test(input.instance_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 ||
      typeof input.request_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.request_id) ||
      !input.credentials || typeof input.credentials !== "object" || Array.isArray(input.credentials) || input.operation_hash !== undefined && !HASH.test(input.operation_hash)) fail(400, "WYVERN_REQUEST_INVALID");
  let config;
  try { config = validateConfig(input.config); } catch { fail(400, "WYVERN_CONFIG_INVALID"); }
  if (config.instance_id !== input.instance_id || Buffer.byteLength(JSON.stringify(input.config)) > 262144) fail(400, "WYVERN_CONFIG_INVALID");
  for (const [id, adapter] of Object.entries(config.adapters)) if (adapter.credential_ref !== credentialKey(input.instance_id, id)) fail(400, "WYVERN_CREDENTIAL_SCOPE_INVALID");
  for (const [id, value] of Object.entries(input.credentials)) {
    if (!Object.hasOwn(config.adapters, id) || typeof value !== "string" || !value.length || Buffer.byteLength(value) > 4096 || /[\r\n\0]/.test(value)) fail(400, "WYVERN_CREDENTIAL_INVALID");
  }
  const hash = createHash("sha256").update(canonical(input)).digest("hex");
  const existing = inspectWyvern(store, input.instance_id);
  if (existing.last_request_id === input.request_id) {
    if (existing.last_request_hash !== hash) fail(409, "WYVERN_REQUEST_CONFLICT");
    return existing;
  }
  if (existing.revision !== input.expected_revision) fail(409, "WYVERN_REVISION_CONFLICT");
  const saved = JSON.parse(store.getSetting(setting(input.instance_id)) || "null") || { credentials: {} };
  // Only the current live Adapter set is granted. Retired encrypted entry
  // revisions remain under the existing Volt retention/recovery contract.
  const credentials = {};
  for (const id of Object.keys(config.adapters)) {
    if (!saved.credentials[id] && !Object.hasOwn(input.credentials, id)) fail(400, "WYVERN_CREDENTIAL_REQUIRED");
  }
  store.db.exec("SAVEPOINT wyvern_publish");
  try {
    for (const id of Object.keys(config.adapters)) {
      let entry = saved.credentials[id];
      if (Object.hasOwn(input.credentials, id)) {
        const body = payload("Wyvern credential", "api_key", input.credentials[id], true);
        if (entry) store.updateEntry(entry, body, { actor: "service:kernel", reason: "Wyvern credential rotation" });
        else entry = store.createEntry(body, { actor: "service:kernel", reason: "Wyvern credential publication" }).id;
      }
      credentials[id] = entry;
    }
    const configPayload = normalizeEntryPayload({ title: "Wyvern configuration", projects: ["Wyvern"], fields: [
      { key: "config", value: JSON.stringify(input.config), visibility: "plain" },
      { key: "repository", value: "https://github.com/psewdon1m-exocortex/wyvern", visibility: "plain" },
    ] });
    const entry = saved.config_id
      ? store.updateEntry(saved.config_id, configPayload, { expectedRevision: input.expected_revision, actor: "service:kernel", reason: "Wyvern configuration publication" })
      : store.createEntry(configPayload, { actor: "service:kernel", reason: "Wyvern initialization" });
    store.setSetting(setting(input.instance_id), JSON.stringify({ config_id: entry.id, credentials, request_id: input.request_id, request_hash: hash, operation_hash: input.operation_hash }));
    store.audit({ actor: "service:kernel", action: "wyvern.publish", target: input.instance_id, details: { revision: entry.revision, adapter_count: Object.keys(credentials).length } });
    store.db.exec("RELEASE wyvern_publish");
    return inspectWyvern(store, input.instance_id);
  } catch (error) {
    store.db.exec("ROLLBACK TO wyvern_publish; RELEASE wyvern_publish");
    throw error;
  }
}
