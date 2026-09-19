import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoltStore } from "../server/store.js";
import { credentialKey, inspectWyvern, publishWyvern } from "../server/wyvern.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "volt-wyvern-"));
  const store = new VoltStore({ filename: path.join(directory, "volt.sqlite"), masterKey: randomBytes(32) });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const config = { schema: "exocortex.wyvern.config.v1", instance_id: "test", clients: {}, adapters: { google: {
    name: "Google", driver: "google", enabled: true, credential_ref: credentialKey("test", "google"),
    profiles: { default: { model: "fixture-model", capabilities: ["text", "structured_output"], max_output_tokens: 8192 } },
  } } };
  return { store, config, input: { instance_id: "test", expected_revision: 0, config, credentials: { google: "synthetic-one" }, request_id: "publication-request-one" } };
}
test("Wyvern publication is scoped, CAS guarded, encrypted and replayable", t => {
  const { store, input } = fixture(t);
  const first = publishWyvern(store, input);
  assert.equal(first.revision, 1);
  assert.deepEqual(publishWyvern(store, input), first);
  assert.throws(() => publishWyvern(store, { ...input, credentials: { google: "different" } }), { code: "WYVERN_REQUEST_CONFLICT" });
  assert.throws(() => publishWyvern(store, { ...input, request_id: "publication-request-two" }), { code: "WYVERN_REVISION_CONFLICT" });
  const second = publishWyvern(store, { ...input, expected_revision: 1, request_id: "publication-request-two", credentials: { google: "synthetic-two" } });
  assert.equal(second.revision, 2);
  assert.deepEqual(first.references, second.references);
  const ref = second.references[credentialKey("test", "google")];
  assert.equal(store.resolveReferences([ref]).values[ref].value, "synthetic-two");
  assert.doesNotMatch(JSON.stringify([second, store.listEntries()]), /synthetic-(one|two)/);
});
test("failure after credential rotation rolls back credential, config and publication metadata", t => {
  const { store, input } = fixture(t);
  const first = publishWyvern(store, input);
  const original = store.updateEntry.bind(store);
  store.updateEntry = (id, value, options) => {
    if (value.title === "Wyvern configuration") throw new Error("injected write failure");
    return original(id, value, options);
  };
  assert.throws(() => publishWyvern(store, { ...input, expected_revision: 1, request_id: "publication-request-two", credentials: { google: "must-roll-back" } }));
  assert.deepEqual(inspectWyvern(store, "test"), first);
  const ref = first.references[credentialKey("test", "google")];
  const credential = store.resolveReferences([ref]).values[ref];
  assert.equal(credential.value, "synthetic-one"); assert.equal(credential.revision, 1);
});
test("publication cannot point an Adapter at another instance's credential or evade capability requirements", t => {
  const { store, input } = fixture(t);
  const config = structuredClone(input.config);
  config.adapters.google.credential_ref = credentialKey("another", "google");
  assert.throws(() => publishWyvern(store, { ...input, config }), { code: "WYVERN_CREDENTIAL_SCOPE_INVALID" });
  config.adapters.google.credential_ref = input.config.adapters.google.credential_ref;
  config.clients.consumer = { token_sha256: "a".repeat(64), enabled: true, allowed_adapters: ["google"], requirements: { media: ["video"] }, bindings: { media: { adapter_id: "google", profile: "default" } } };
  assert.throws(() => publishWyvern(store, { ...input, config }), { code: "WYVERN_CONFIG_INVALID" });
  assert.equal(inspectWyvern(store, "test").revision, 0);
});
