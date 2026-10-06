import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { decryptRevision, unwrapEntryKey } from "./crypto.js";
import { hashAccessKey, verifyAccessKey } from "./security.js";
import { domainError } from "./store.js";

const DAY = 86_400_000;
const SESSION_MS = 30 * 60_000;
const MAX_DAYS = 30;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const hash = value => createHash("sha256").update(value).digest("hex");
const nowIso = () => new Date().toISOString();

function expiry(value, fallback = null) {
  if (value === undefined) return fallback ?? new Date(Date.now() + DAY).toISOString();
  if (typeof value !== "string") throw domainError(400, "SHARE_EXPIRY_INVALID", "Choose an expiry within 30 days");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || date.getTime() > Date.now() + MAX_DAYS * DAY) {
    throw domainError(400, "SHARE_EXPIRY_INVALID", "Choose an expiry within 30 days");
  }
  return date.toISOString();
}

function passwordHash(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096) {
    throw domainError(400, "SHARE_PASSWORD_INVALID", "Share password is too long");
  }
  return hashAccessKey(value);
}

function same(left, right) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ShareService {
  constructor(store) {
    this.store = store;
    const filename = `${store.filename}.share-key`;
    try {
      writeFileSync(filename, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
      // An old portable vault can be copied without this instance-only key.
      // Its links must never become usable again with a newly generated key.
      store.db.prepare("UPDATE shares SET revoked_at = ?, policy_version = policy_version + 1 WHERE revoked_at IS NULL")
        .run(nowIso());
      store.db.exec("DELETE FROM share_sessions");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    this.key = Buffer.from(readFileSync(filename, "utf8").trim(), "base64url");
    if (this.key.length !== 32) throw new Error("Volt Share key is invalid");
  }

  token(id) {
    return createHmac("sha256", this.key).update(`volt-share-v1:${id}`).digest("base64url");
  }

  link(id) {
    return `/share/${id}#${this.token(id)}`;
  }

  row(id, active = true) {
    if (!ID.test(String(id))) throw domainError(404, "SHARE_NOT_FOUND", "Share is unavailable");
    const row = this.store.db.prepare("SELECT * FROM shares WHERE id = ?").get(id);
    if (!row || (active && (row.revoked_at || row.expires_at <= nowIso()))) {
      throw domainError(404, "SHARE_NOT_FOUND", "Share is unavailable");
    }
    return row;
  }

  snapshot(row) {
    const revision = this.store.db.prepare(`SELECT e.id AS entry_id, e.deleted_at, e.wrapped_key, e.key_nonce, e.key_tag,
      r.id AS revision_id, r.revision_number, r.ciphertext, r.nonce, r.tag
      FROM entries e JOIN entry_revisions r ON r.entry_id = e.id
      WHERE e.id = ? AND r.id = ?`).get(row.entry_id, row.revision_id);
    if (!revision || revision.deleted_at) throw domainError(404, "SHARE_NOT_FOUND", "Share is unavailable");
    const entryKey = unwrapEntryKey(this.store.masterKey, row.entry_id, revision);
    try {
      const payload = decryptRevision(entryKey, row.entry_id, row.revision_id, revision);
      const selected = new Set(JSON.parse(row.field_ids));
      return { title: payload.title, revision: revision.revision_number,
        fields: payload.fields.filter(field => selected.has(field.id)) };
    } finally { entryKey.fill(0); }
  }

  create({ entry_id: entryId, field_ids: fieldIds, expected_revision: expectedRevision, password = null, expires_at: expiresAt } = {}) {
    if (!ID.test(String(entryId)) || !Array.isArray(fieldIds) || !fieldIds.length || fieldIds.length > 20
      || new Set(fieldIds).size !== fieldIds.length || fieldIds.some(id => !ID.test(String(id)))) {
      throw domainError(400, "SHARE_FIELDS_INVALID", "Select one or more fields from one entry");
    }
    const until = expiry(expiresAt);
    const verifier = passwordHash(password);
    const activeCount = this.store.db.prepare("SELECT COUNT(*) AS n FROM shares WHERE revoked_at IS NULL").get().n;
    if (activeCount >= 500) throw domainError(409, "SHARE_LIMIT", "Revoke an existing Share before creating another");
    const entry = this.store.db.prepare(`SELECT e.current_revision_id, r.revision_number FROM entries e
      JOIN entry_revisions r ON r.id = e.current_revision_id WHERE e.id = ? AND e.deleted_at IS NULL`).get(entryId);
    if (!entry) throw domainError(404, "ENTRY_NOT_FOUND", "Entry not found");
    if (!Number.isInteger(expectedRevision) || expectedRevision !== entry.revision_number) {
      throw domainError(409, "ENTRY_REVISION_CONFLICT", "Entry changed. Reload it before sharing");
    }
    const id = randomUUID(), created = nowIso();
    const record = { id, entry_id: entryId, revision_id: entry.current_revision_id, field_ids: JSON.stringify(fieldIds) };
    const selected = this.snapshot(record);
    if (selected.fields.length !== fieldIds.length) throw domainError(400, "SHARE_FIELDS_INVALID", "Selected fields are not in the current revision");
    this.store.db.prepare(`INSERT INTO shares(id, entry_id, revision_id, field_ids, password_hash, created_at, updated_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(id, entryId, entry.current_revision_id, record.field_ids, verifier, created, created, until);
    this.store.audit({ actor: "operator", action: "share.create", target: id, details: { entry_id: entryId, field_count: fieldIds.length } });
    return { id, path: this.link(id) };
  }

  list() {
    return this.store.db.prepare("SELECT * FROM shares WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 500").all()
      .map(row => {
        let selected;
        try { selected = this.snapshot(row); }
        catch (error) { if (error.code !== "SHARE_NOT_FOUND") throw error; selected = null; }
        return { id: row.id, entry_id: row.entry_id, title: selected?.title ?? "Unavailable entry",
          revision: selected?.revision ?? null, field_names: selected?.fields.map(field => field.key) ?? [],
          field_count: JSON.parse(row.field_ids).length, password_required: Boolean(row.password_hash),
          created_at: row.created_at, updated_at: row.updated_at, expires_at: row.expires_at,
          status: !selected ? "unavailable" : row.expires_at <= nowIso() ? "expired" : "active" };
      });
  }

  change(id, values) {
    const row = this.row(id, false);
    if (row.revoked_at) throw domainError(409, "SHARE_REVOKED", "Share has been revoked");
    if (!values || typeof values !== "object" || Array.isArray(values)
      || !Object.keys(values).length || Object.keys(values).some(key => !["expires_at", "password", "revoke"].includes(key))
      || ("revoke" in values && values.revoke !== true)) {
      throw domainError(400, "SHARE_POLICY_INVALID", "Invalid Share policy");
    }
    const until = "expires_at" in values ? expiry(values.expires_at) : row.expires_at;
    const verifier = "password" in values ? passwordHash(values.password) : row.password_hash;
    const revoked = values.revoke ? nowIso() : null;
    this.store.db.exec("SAVEPOINT share_policy");
    try {
      this.store.db.prepare(`UPDATE shares SET expires_at = ?, password_hash = ?, revoked_at = ?,
        updated_at = ?, policy_version = policy_version + 1 WHERE id = ?`)
        .run(until, verifier, revoked, nowIso(), id);
      this.store.db.prepare("DELETE FROM share_sessions WHERE share_id = ?").run(id);
      this.store.db.exec("RELEASE share_policy");
    } catch (error) {
      this.store.db.exec("ROLLBACK TO share_policy; RELEASE share_policy");
      throw error;
    }
    this.store.audit({ actor: "operator", action: revoked ? "share.revoke" : "share.policy", target: id });
    return { updated: true };
  }

  policy(id) {
    const row = this.row(id);
    return { password_required: Boolean(row.password_hash), expires_at: row.expires_at };
  }

  unlock(id, token, password, address) {
    const row = this.row(id);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !same(token, this.token(id))) {
      throw domainError(404, "SHARE_NOT_FOUND", "Share is unavailable");
    }
    const db = this.store.db, cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    const addressHash = createHmac("sha256", this.key).update(String(address)).digest("hex");
    db.prepare("DELETE FROM share_attempts WHERE occurred_at < ?").run(cutoff);
    const shareCount = db.prepare("SELECT COUNT(*) AS n FROM share_attempts WHERE share_id = ?").get(id).n;
    const addressCount = db.prepare("SELECT COUNT(*) AS n FROM share_attempts WHERE address_hash = ?").get(addressHash).n;
    if (shareCount >= 10 || addressCount >= 20) throw domainError(429, "SHARE_RATE_LIMITED", "Try again later");
    if (row.password_hash && (typeof password !== "string" || Buffer.byteLength(password, "utf8") > 4096
      || !verifyAccessKey(password, row.password_hash))) {
      db.prepare("INSERT INTO share_attempts(share_id, address_hash, occurred_at) VALUES(?, ?, ?)").run(id, addressHash, nowIso());
      this.store.audit({ actor: `share:${id}`, action: "share.unlock", target: id, status: "denied" });
      throw domainError(401, "SHARE_PASSWORD_INVALID", "Share password is incorrect");
    }
    const session = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Math.min(Date.parse(row.expires_at), Date.now() + SESSION_MS)).toISOString();
    db.prepare("DELETE FROM share_sessions WHERE expires_at <= ?").run(nowIso());
    db.prepare(`DELETE FROM share_sessions WHERE token_hash IN
      (SELECT token_hash FROM share_sessions WHERE share_id = ? ORDER BY expires_at DESC LIMIT -1 OFFSET 49)`).run(id);
    const totalSessions = db.prepare("SELECT COUNT(*) AS n FROM share_sessions").get().n;
    if (totalSessions >= 2000) db.prepare("DELETE FROM share_sessions WHERE token_hash = (SELECT token_hash FROM share_sessions ORDER BY expires_at LIMIT 1)").run();
    db.prepare("INSERT INTO share_sessions(token_hash, share_id, policy_version, expires_at) VALUES(?, ?, ?, ?)")
      .run(hash(session), id, row.policy_version, expiresAt);
    this.store.audit({ actor: `share:${id}`, action: "share.open", target: id });
    return { token: session, expires_at: expiresAt };
  }

  authorize(id, session) {
    const row = this.row(id);
    if (typeof session !== "string") throw domainError(401, "SHARE_SESSION_REQUIRED", "Open the Share link again");
    const current = this.store.db.prepare("SELECT * FROM share_sessions WHERE token_hash = ? AND share_id = ?").get(hash(session), id);
    if (!current || current.expires_at <= nowIso() || current.policy_version !== row.policy_version) {
      throw domainError(401, "SHARE_SESSION_REQUIRED", "Open the Share link again");
    }
    return row;
  }

  view(id, session) {
    const record = this.snapshot(this.authorize(id, session));
    return { title: record.title, revision: record.revision,
      fields: record.fields.map(field => ({ id: field.id, key: field.key, visibility: field.visibility,
        value: field.visibility === "plain" ? field.value : null, length: field.visibility === "secret" ? [...field.value].length : undefined })) };
  }

  reveal(id, session, fieldId) {
    const record = this.snapshot(this.authorize(id, session));
    const field = record.fields.find(candidate => candidate.id === fieldId);
    if (!field) throw domainError(404, "SHARE_FIELD_NOT_FOUND", "Field not found");
    this.store.audit({ actor: `share:${id}`, action: "share.reveal", target: id, details: { field_id: fieldId } });
    return { value: field.value };
  }
}
