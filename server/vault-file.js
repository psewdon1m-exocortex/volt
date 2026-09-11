import {
  argon2Sync,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { verifyAccessKey } from "./security.js";

const FORMAT = "exocortex-personal-volt";
const FORMAT_VERSION = 1;
const ACCESS_MEMORY_KIB = 64 * 1024;
const ACCESS_PASSES = 3;
const ACCESS_PARALLELISM = 1;

function vaultError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertKey(key, name) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw vaultError("VAULT_KEY_INVALID", `${name} must contain exactly 32 bytes`);
  }
}

function assertAccessKey(accessKey) {
  if (typeof accessKey !== "string" || accessKey.length < 12 || accessKey.length > 512) {
    throw vaultError("VAULT_ACCESS_KEY_INVALID", "Access Key must contain between 12 and 512 characters");
  }
}

function seal(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function open(key, wrapped, aad) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(wrapped.nonce, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(wrapped.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(wrapped.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

function createKdf() {
  return {
    algorithm: "argon2id",
    version: 19,
    memory_kib: ACCESS_MEMORY_KIB,
    passes: ACCESS_PASSES,
    parallelism: ACCESS_PARALLELISM,
    salt: randomBytes(16).toString("base64url"),
  };
}

function validateKdf(value) {
  if (
    value?.algorithm !== "argon2id"
    || value.version !== 19
    || !Number.isInteger(value.memory_kib) || value.memory_kib < 8_192 || value.memory_kib > 1024 * 1024
    || !Number.isInteger(value.passes) || value.passes < 1 || value.passes > 20
    || !Number.isInteger(value.parallelism) || value.parallelism < 1 || value.parallelism > 16
    || Buffer.from(String(value.salt ?? ""), "base64url").length !== 16
  ) throw vaultError("VAULT_KDF_INVALID", "personal.volt contains unsupported Access Key parameters");
  return value;
}

function deriveAccessWrapKey(accessKey, kdf) {
  assertAccessKey(accessKey);
  const checked = validateKdf(kdf);
  return argon2Sync("argon2id", {
    message: Buffer.from(accessKey, "utf8"),
    nonce: Buffer.from(checked.salt, "base64url"),
    parallelism: checked.parallelism,
    tagLength: 32,
    memory: checked.memory_kib,
    passes: checked.passes,
  });
}

function deriveDeviceWrapKey(deviceKey, vaultId) {
  assertKey(deviceKey, "Device key");
  return Buffer.from(hkdfSync(
    "sha256",
    deviceKey,
    Buffer.from(vaultId, "utf8"),
    "exocortex-volt/device-wrap/v1",
    32,
  ));
}

function accessAad(vaultId, kdf) {
  return `${FORMAT}:access-wrap:v1:${vaultId}:${JSON.stringify(kdf)}`;
}

function deviceAad(vaultId) {
  return `${FORMAT}:device-wrap:v1:${vaultId}`;
}

export function buildAccessWrapper(masterKey, vaultId, accessKey) {
  assertKey(masterKey, "Vault master key");
  const kdf = createKdf();
  const wrapped = seal(deriveAccessWrapKey(accessKey, kdf), masterKey, accessAad(vaultId, kdf));
  return { kdf, wrapped };
}

function buildDeviceWrapper(masterKey, vaultId, deviceKey) {
  if (!deviceKey) return null;
  assertKey(masterKey, "Vault master key");
  return seal(deriveDeviceWrapKey(deviceKey, vaultId), masterKey, deviceAad(vaultId));
}

function createHeaderSchema(db) {
  db.exec(`
    PRAGMA application_id = 0x564f4c54;
    PRAGMA user_version = ${FORMAT_VERSION};
    CREATE TABLE IF NOT EXISTS vault_header (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      format TEXT NOT NULL,
      format_version INTEGER NOT NULL,
      vault_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      access_kdf_json TEXT NOT NULL,
      access_ciphertext TEXT NOT NULL,
      access_nonce TEXT NOT NULL,
      access_tag TEXT NOT NULL,
      device_ciphertext TEXT,
      device_nonce TEXT,
      device_tag TEXT
    ) STRICT;
  `);
}

function insertHeader(db, { vaultId, masterKey, accessKey, deviceKey }) {
  const access = buildAccessWrapper(masterKey, vaultId, accessKey);
  const device = buildDeviceWrapper(masterKey, vaultId, deviceKey);
  db.prepare(`
    INSERT INTO vault_header(
      singleton, format, format_version, vault_id, created_at,
      access_kdf_json, access_ciphertext, access_nonce, access_tag,
      device_ciphertext, device_nonce, device_tag
    ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    FORMAT,
    FORMAT_VERSION,
    vaultId,
    new Date().toISOString(),
    JSON.stringify(access.kdf),
    access.wrapped.ciphertext,
    access.wrapped.nonce,
    access.wrapped.tag,
    device?.ciphertext ?? null,
    device?.nonce ?? null,
    device?.tag ?? null,
  );
}

function readHeader(filename) {
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    const applicationId = Number(db.prepare("PRAGMA application_id").get().application_id);
    const row = db.prepare("SELECT * FROM vault_header WHERE singleton = 1").get();
    if (applicationId !== 0x564f4c54 || row?.format !== FORMAT || Number(row.format_version) !== FORMAT_VERSION) {
      throw vaultError("VAULT_FORMAT_INVALID", "File is not a supported personal.volt vault");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.vault_id)) {
      throw vaultError("VAULT_FORMAT_INVALID", "personal.volt has an invalid vault identifier");
    }
    return {
      vaultId: row.vault_id,
      createdAt: row.created_at,
      kdf: validateKdf(JSON.parse(row.access_kdf_json)),
      access: { ciphertext: row.access_ciphertext, nonce: row.access_nonce, tag: row.access_tag },
      device: row.device_ciphertext
        ? { ciphertext: row.device_ciphertext, nonce: row.device_nonce, tag: row.device_tag }
        : null,
    };
  } catch (error) {
    if (error.code) throw error;
    throw vaultError("VAULT_FORMAT_INVALID", "File is not a readable personal.volt vault");
  } finally {
    db?.close();
  }
}

function installDeviceWrapper(filename, vaultId, masterKey, deviceKey) {
  const device = buildDeviceWrapper(masterKey, vaultId, deviceKey);
  const db = new DatabaseSync(filename);
  try {
    db.prepare(`
      UPDATE vault_header
      SET device_ciphertext = ?, device_nonce = ?, device_tag = ?
      WHERE singleton = 1 AND device_ciphertext IS NULL
    `).run(device.ciphertext, device.nonce, device.tag);
  } finally {
    db.close();
  }
  return device;
}

export function createPortableVault({ filename, accessKey, deviceKey = null, masterKey = randomBytes(32) }) {
  assertAccessKey(accessKey);
  assertKey(masterKey, "Vault master key");
  if (deviceKey) assertKey(deviceKey, "Device key");
  if (existsSync(filename)) throw vaultError("VAULT_EXISTS", "personal.volt already exists");
  mkdirSync(path.dirname(filename), { recursive: true });
  const vaultId = randomUUID();
  const db = new DatabaseSync(filename);
  try {
    createHeaderSchema(db);
    insertHeader(db, { vaultId, masterKey, accessKey, deviceKey });
  } catch (error) {
    db.close();
    try { unlinkSync(filename); } catch {}
    throw error;
  }
  db.close();
  try { chmodSync(filename, 0o600); } catch {}
  return { filename, vaultId, masterKey, created: true, unlockedWith: "created" };
}

export function unlockPortableVault({ filename, accessKey = null, deviceKey = null, allowDeviceUnlock = false }) {
  if (!existsSync(filename)) throw vaultError("VAULT_NOT_FOUND", "personal.volt does not exist");
  const header = readHeader(filename);
  if (allowDeviceUnlock && deviceKey && header.device) {
    try {
      const masterKey = open(deriveDeviceWrapKey(deviceKey, header.vaultId), header.device, deviceAad(header.vaultId));
      assertKey(masterKey, "Vault master key");
      return { filename, ...header, masterKey, created: false, unlockedWith: "device" };
    } catch {}
  }
  if (accessKey) {
    try {
      const masterKey = open(
        deriveAccessWrapKey(accessKey, header.kdf),
        header.access,
        accessAad(header.vaultId, header.kdf),
      );
      assertKey(masterKey, "Vault master key");
      if (deviceKey && !header.device) header.device = installDeviceWrapper(
        filename,
        header.vaultId,
        masterKey,
        deviceKey,
      );
      return { filename, ...header, masterKey, created: false, unlockedWith: "access-key" };
    } catch {}
  }
  throw vaultError("VAULT_UNLOCK_FAILED", "personal.volt could not be unlocked with the supplied credentials");
}

export function migrateLegacyVault({ legacyFilename, filename, accessKey, legacyMasterKey, deviceKey = legacyMasterKey }) {
  if (!existsSync(legacyFilename) || existsSync(filename)) return null;
  assertAccessKey(accessKey);
  assertKey(legacyMasterKey, "Legacy master key");
  const legacy = new DatabaseSync(legacyFilename);
  try {
    const verifier = legacy.prepare("SELECT value FROM settings WHERE key = 'access_key_hash'").get()?.value;
    if (!verifier || !verifyAccessKey(accessKey, verifier)) {
      throw vaultError("LEGACY_ACCESS_KEY_MISMATCH", "Configured Access Key does not unlock the legacy Volt database");
    }
    legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    legacy.close();
  }

  mkdirSync(path.dirname(filename), { recursive: true });
  copyFileSync(legacyFilename, filename, fsConstants.COPYFILE_EXCL);
  const db = new DatabaseSync(filename);
  const vaultId = randomUUID();
  try {
    createHeaderSchema(db);
    insertHeader(db, { vaultId, masterKey: legacyMasterKey, accessKey, deviceKey });
  } catch (error) {
    db.close();
    try { unlinkSync(filename); } catch {}
    throw error;
  }
  db.close();
  try { chmodSync(filename, 0o600); } catch {}
  return { filename, vaultId, masterKey: legacyMasterKey, created: false, migrated: true, unlockedWith: "migration" };
}

export function rotatePortableAccessKey(db, masterKey, accessKey) {
  const row = db.prepare("SELECT vault_id FROM vault_header WHERE singleton = 1").get();
  if (!row) throw vaultError("VAULT_FORMAT_INVALID", "personal.volt header is missing");
  const access = buildAccessWrapper(masterKey, row.vault_id, accessKey);
  db.prepare(`
    UPDATE vault_header
    SET access_kdf_json = ?, access_ciphertext = ?, access_nonce = ?, access_tag = ?
    WHERE singleton = 1
  `).run(
    JSON.stringify(access.kdf),
    access.wrapped.ciphertext,
    access.wrapped.nonce,
    access.wrapped.tag,
  );
}

export function portableVaultInfo(filename) {
  const header = readHeader(filename);
  return {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    vault_id: header.vaultId,
    created_at: header.createdAt,
    access_kdf: {
      algorithm: header.kdf.algorithm,
      memory_kib: header.kdf.memory_kib,
      passes: header.kdf.passes,
      parallelism: header.kdf.parallelism,
    },
    has_device_wrapper: Boolean(header.device),
  };
}

export { FORMAT as PORTABLE_VAULT_FORMAT, FORMAT_VERSION as PORTABLE_VAULT_VERSION };
