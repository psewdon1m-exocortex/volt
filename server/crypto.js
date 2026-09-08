import fs from "node:fs";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export function readMasterKey(filename) {
  const encoded = fs.readFileSync(filename, "utf8").trim();
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw new Error("Volt master key must decode to exactly 32 bytes");
  return key;
}

export function deriveSessionKey(masterKey) {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "exocortex-volt/session/v1", 32));
}

function seal(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function open(key, sealed, aad) {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(sealed.nonce, "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

export function createWrappedEntryKey(masterKey, entryId) {
  const entryKey = randomBytes(32);
  const wrapped = seal(masterKey, entryKey, `exocortex-volt:item-key:v1:${entryId}`);
  return { entryKey, wrapped };
}

export function unwrapEntryKey(masterKey, entryId, row) {
  return open(masterKey, {
    ciphertext: row.wrapped_key,
    nonce: row.key_nonce,
    tag: row.key_tag,
  }, `exocortex-volt:item-key:v1:${entryId}`);
}

export function encryptRevision(entryKey, entryId, revisionId, payload) {
  return seal(
    entryKey,
    Buffer.from(JSON.stringify(payload), "utf8"),
    `exocortex-volt:entry:v1:${entryId}:${revisionId}`,
  );
}

export function decryptRevision(entryKey, entryId, revisionId, row) {
  const plaintext = open(entryKey, {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    tag: row.tag,
  }, `exocortex-volt:entry:v1:${entryId}:${revisionId}`);
  return JSON.parse(plaintext.toString("utf8"));
}
