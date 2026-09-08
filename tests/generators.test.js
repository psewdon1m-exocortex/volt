import assert from "node:assert/strict";
import test from "node:test";

import { generateValue } from "../server/generators.js";

test("password generator honors character exclusions and reports entropy", () => {
  const generated = generateValue({ type: "password", length: 32, lower: true, upper: true, digits: true, special: true });
  assert.equal(generated.values.length, 1);
  assert.equal(generated.values[0].value.length, 32);
  assert.equal(/["@]/.test(generated.values[0].value), false);
  assert.ok(generated.entropy_bits > 150);
});

test("identifier and HMAC generators use stable encodings", () => {
  const identifier = generateValue({ type: "identifier" }).values[0].value;
  const hmac = generateValue({ type: "hmac", bytes: 32 }).values[0].value;
  assert.match(identifier, /^[A-Z0-9]{16}$/);
  assert.match(hmac, /^[A-Za-z0-9_-]{43}$/);
});

test("RSA generator returns a private/public pair", () => {
  const generated = generateValue({ type: "rsa", modulus_length: 2048 });
  assert.match(generated.values[0].value, /BEGIN PRIVATE KEY/);
  assert.match(generated.values[1].value, /BEGIN PUBLIC KEY/);
});

test("certificate generator returns a certificate/private-key pair", async () => {
  const generated = await generateValue({
    type: "certificate",
    common_name: "localhost",
    sans: ["localhost", "127.0.0.1"],
    valid_days: 30,
  });
  assert.match(generated.values[0].value, /BEGIN CERTIFICATE/);
  assert.match(generated.values[1].value, /BEGIN PRIVATE KEY/);
});
