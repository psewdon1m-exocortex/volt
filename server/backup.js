import { createHash } from "node:crypto";

import { strToU8, unzipSync, zipSync } from "fflate";

import { domainError } from "./store.js";

const FORMAT = "exocortex-volt-logical-backup";
const SCHEMA_VERSION = 2;
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MEMBER_TABLES = {
  "data/settings.jsonl": "settings",
  "data/entries.jsonl": "entries",
  "history/revisions.jsonl": "revisions",
  "diagnostics/audit.jsonl": "audit",
};
const LEGACY_MEMBER_TABLES = {
  ...MEMBER_TABLES,
  "data/principals.jsonl": "principals",
  "data/grants.jsonl": "grants",
};
const ALL_KNOWN_MEMBERS = new Set(["manifest.json", "README.txt", ...Object.keys(LEGACY_MEMBER_TABLES)]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lines(rows) {
  return strToU8(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

export function buildBackupArchive(state, version = "0.1.0") {
  const files = {};
  const members = {};
  for (const [member, table] of Object.entries(MEMBER_TABLES)) {
    const bytes = lines(state[table]);
    members[member] = bytes;
    files[member] = { sha256: sha256(bytes), uncompressed_bytes: bytes.byteLength, records: state[table].length };
  }
  members["README.txt"] = strToU8(
    "Exocortex Volt logical backup.\n\nContains ciphertext and metadata, never plaintext secret values, Access Key verifiers or bearer tokens.\nRestore target must be the same personal.volt vault. Restore mode: replace.\n",
  );
  const manifest = {
    format: FORMAT,
    schema_version: SCHEMA_VERSION,
    source_version: version,
    created_at: new Date().toISOString(),
    scope: "complete",
    restore_mode: "replace",
    encryption: { scheme: "AES-256-GCM envelope encryption", external_key_required: true },
    files,
  };
  members["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(members, { level: 6 });
}

function parseJsonLines(bytes, member, maximumRecords) {
  const text = Buffer.from(bytes).toString("utf8");
  const rows = text ? text.trimEnd().split("\n") : [];
  if (rows.length > maximumRecords) throw domainError(413, "BACKUP_TOO_LARGE", `${member} has too many records`);
  try { return rows.map((line) => JSON.parse(line)); }
  catch { throw domainError(400, "BACKUP_JSON_INVALID", `${member} contains invalid JSONL`); }
}

export function parseBackupArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_COMPRESSED_BYTES) {
    throw domainError(413, "BACKUP_TOO_LARGE", "Backup must be a non-empty ZIP no larger than 32 MiB");
  }
  let members;
  try {
    let claimedBytes = 0;
    let memberCount = 0;
    members = unzipSync(bytes, { filter: (file) => {
      memberCount += 1;
      if (memberCount > ALL_KNOWN_MEMBERS.size || !ALL_KNOWN_MEMBERS.has(file.name)) {
        throw domainError(400, "BACKUP_MEMBERS_INVALID", "Backup members do not match the Volt allow-list");
      }
      claimedBytes += Number(file.originalSize);
      if (claimedBytes > MAX_UNCOMPRESSED_BYTES || Number(file.originalSize) > MAX_UNCOMPRESSED_BYTES) {
        throw domainError(413, "BACKUP_TOO_LARGE", "Backup declares too much uncompressed data");
      }
      return true;
    } });
  } catch (error) {
    if (error.code) throw error;
    throw domainError(400, "BACKUP_ZIP_INVALID", "Backup is not a valid ZIP archive");
  }
  const names = Object.keys(members);
  const total = Object.values(members).reduce((sum, member) => sum + member.byteLength, 0);
  if (total > MAX_UNCOMPRESSED_BYTES || total / bytes.length > 200) {
    throw domainError(413, "BACKUP_TOO_LARGE", "Backup exceeds uncompressed size or compression ratio limits");
  }
  let manifest;
  try { manifest = JSON.parse(Buffer.from(members["manifest.json"]).toString("utf8")); }
  catch { throw domainError(400, "BACKUP_MANIFEST_INVALID", "Backup manifest is invalid"); }
  if (manifest.format !== FORMAT || ![1, SCHEMA_VERSION].includes(manifest.schema_version) || manifest.restore_mode !== "replace") {
    throw domainError(400, "BACKUP_VERSION_UNSUPPORTED", "Backup format or schema version is unsupported");
  }
  const memberTables = manifest.schema_version === 1 ? LEGACY_MEMBER_TABLES : MEMBER_TABLES;
  const allowedMembers = new Set(["manifest.json", "README.txt", ...Object.keys(memberTables)]);
  if (names.length !== allowedMembers.size || names.some((name) => !allowedMembers.has(name))) {
    throw domainError(400, "BACKUP_MEMBERS_INVALID", "Backup members do not match the Volt allow-list");
  }
  const state = {};
  for (const [member, table] of Object.entries(memberTables)) {
    const metadata = manifest.files?.[member];
    const data = members[member];
    if (!metadata || metadata.sha256 !== sha256(data) || metadata.uncompressed_bytes !== data.byteLength) {
      throw domainError(400, "BACKUP_CHECKSUM_MISMATCH", `Integrity check failed for ${member}`);
    }
    state[table] = parseJsonLines(data, member, table === "audit" || table === "revisions" ? 100_000 : 20_000);
    if (state[table].length !== metadata.records) throw domainError(400, "BACKUP_COUNT_MISMATCH", `Record count failed for ${member}`);
  }
  delete state.principals;
  delete state.grants;
  return { state, manifest, digest: sha256(bytes) };
}

export { MAX_COMPRESSED_BYTES };
