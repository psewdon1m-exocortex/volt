import assert from "node:assert/strict";
import test from "node:test";
import { trustedProxies } from "../server/proxy-policy.js";
test("only explicit proxy addresses are accepted", () => {
  assert.equal(trustedProxies(), false);
  assert.deepEqual(trustedProxies("127.0.0.1,172.31.250.2/32 ::1/128"), ["127.0.0.1", "172.31.250.2/32", "::1/128"]);
  for (const value of ["true", "0.0.0.0/0", "::/0", "example.com", "10.0.0.1/33", "127.0.0.1/32/24"]) assert.throws(() => trustedProxies(value));
});
