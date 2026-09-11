import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createWrappedEntryKey,
  decryptRevision,
  encryptRevision,
  unwrapEntryKey,
  rewrapEntryKey,
} from "./crypto.js";
import { portableVaultInfo, rotatePortableAccessKey, unlockPortableVault } from "./vault-file.js";

function isoNow() {
  return new Date().toISOString();
}

const DEFAULT_ACCENT = "#00A8FF";
const DEFAULT_NAVIGATION_ORDER = ["dashboard", "vault", "trash", "audit", "settings"];
const DEFAULT_SETTINGS_ORDER = ["appearance", "security", "backup", "updates", "logs", "cryptography"];
const DEFAULT_DASHBOARD_ORDER = ["cpu", "memory", "disk", "uptime", "entities"];
export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const MIN_TRASH_RETENTION_DAYS = 1;
export const MAX_TRASH_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

function trashDeadline(deletedAt, retentionDays) {
  return new Date(new Date(deletedAt).getTime() + retentionDays * DAY_MS).toISOString();
}

function validOrder(value, allowed) {
  return Array.isArray(value)
    && value.length === allowed.length
    && new Set(value).size === allowed.length
    && value.every((item) => allowed.includes(item));
}

function relativeLuminance(hex) {
  const weights = [0.2126, 0.7152, 0.0722];
  return [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * weights[index], 0);
}

function domainError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function maskPayload(payload) {
  return {
    schema: payload.schema,
    title: payload.title,
    project: payload.project,
    fields: payload.fields.map((field) => ({
      id: field.id,
      key: field.key,
      visibility: field.visibility,
      generator: field.generator ?? null,
      value: field.visibility === "secret" ? null : field.value,
      masked: field.visibility === "secret",
    })),
  };
}

export function parseVoltReference(reference) {
  const match = /^(?:volt:\/\/|secret:\/\/volt\/)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([1-5])$/i.exec(String(reference));
  if (!match) throw domainError(400, "INVALID_VOLT_REFERENCE", "Expected volt://<entry-id>/<value-position>");
  return { entryId: match[1].toLowerCase(), fieldPosition: Number(match[2]) };
}

export class VoltStore {
  constructor({ filename, masterKey, auditRetention = 10_000 }) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.filename = filename;
    this.masterKey = masterKey;
    this.auditRetention = auditRetention;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuAt = process.hrtime.bigint();
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.#createSchema();
    this.purgeExpiredEntries();
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        current_revision_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        wrapped_key TEXT NOT NULL,
        key_nonce TEXT NOT NULL,
        key_tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (current_revision_id) REFERENCES entry_revisions(id)
      );
      CREATE TABLE IF NOT EXISTS entry_revisions (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        parent_revision_id TEXT,
        source_revision_id TEXT,
        ciphertext TEXT NOT NULL,
        nonce TEXT NOT NULL,
        tag TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (entry_id, revision_number),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_revision_id) REFERENCES entry_revisions(id),
        FOREIGN KEY (source_revision_id) REFERENCES entry_revisions(id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        status TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_position ON entries(deleted_at, position, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_revisions_entry ON entry_revisions(entry_id, revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
    `);
    // Service principals and field grants belonged to the retired direct-service
    // API. Kernel is now the sole machine principal for secret resolution.
    this.db.exec("DROP TABLE IF EXISTS grants; DROP TABLE IF EXISTS principals;");
    if (!this.getSetting("auth_generation")) this.setSetting("auth_generation", "1");
    if (!this.getSetting("appearance")) this.setSetting("appearance", "dark");
    if (!this.getSetting("accent_color")) this.setSetting("accent_color", DEFAULT_ACCENT);
    if (!this.getSetting("sidebar_mode")) this.setSetting("sidebar_mode", "fixed");
    if (!this.getSetting("navigation_order")) this.setSetting("navigation_order", JSON.stringify(DEFAULT_NAVIGATION_ORDER));
    if (!this.getSetting("settings_order")) this.setSetting("settings_order", JSON.stringify(DEFAULT_SETTINGS_ORDER));
    if (!this.getSetting("dashboard_order")) this.setSetting("dashboard_order", JSON.stringify(DEFAULT_DASHBOARD_ORDER));
    if (!this.getSetting("trash_retention_days")) this.setSetting("trash_retention_days", DEFAULT_TRASH_RETENTION_DAYS);
  }

  close() {
    this.db.close();
  }

  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  getSetting(key) {
    return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getTrashRetentionDays() {
    const value = Number(this.getSetting("trash_retention_days"));
    return Number.isInteger(value) && value >= MIN_TRASH_RETENTION_DAYS && value <= MAX_TRASH_RETENTION_DAYS
      ? value
      : DEFAULT_TRASH_RETENTION_DAYS;
  }

  setTrashRetentionDays(value, { actor = "operator" } = {}) {
    const retentionDays = Number(value);
    if (!Number.isInteger(retentionDays) || retentionDays < MIN_TRASH_RETENTION_DAYS || retentionDays > MAX_TRASH_RETENTION_DAYS) {
      throw domainError(400, "TRASH_RETENTION_INVALID", `Trash retention must be an integer from ${MIN_TRASH_RETENTION_DAYS} to ${MAX_TRASH_RETENTION_DAYS} days`);
    }
    const previous = this.getTrashRetentionDays();
    this.setSetting("trash_retention_days", retentionDays);
    if (retentionDays !== previous) {
      this.audit({ actor, action: "settings.trash_retention.update", details: { previous_days: previous, retention_days: retentionDays } });
    }
    return retentionDays;
  }

  getAuthGeneration() {
    return Number(this.getSetting("auth_generation") ?? 1);
  }

  incrementAuthGeneration() {
    const generation = this.getAuthGeneration() + 1;
    this.setSetting("auth_generation", generation);
    return generation;
  }

  rotateAccessKey(accessKey, accessKeyHash) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      rotatePortableAccessKey(this.db, this.masterKey, accessKey);
      this.setSetting("access_key_hash", accessKeyHash);
      const generation = this.incrementAuthGeneration();
      this.db.exec("COMMIT");
      return generation;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPortableVaultInfo() {
    this.checkpoint();
    return portableVaultInfo(this.filename);
  }

  createPortableSnapshot() {
    this.checkpoint();
    const temporary = `${this.filename}.export-${randomUUID()}`;
    const sqlFilename = temporary.replaceAll("'", "''");
    try {
      this.db.exec(`VACUUM INTO '${sqlFilename}'`);
      return readFileSync(temporary);
    } finally {
      try { unlinkSync(temporary); } catch {}
    }
  }

  getAppearance() {
    return this.getSetting("appearance") === "light" ? "light" : "dark";
  }

  setAppearance(value) {
    const appearance = value === "light" ? "light" : "dark";
    this.setSetting("appearance", appearance);
    return appearance;
  }

  getInterfaceSettings() {
    const accent = String(this.getSetting("accent_color") ?? DEFAULT_ACCENT).toUpperCase();
    const navigationOrder = parseJson(this.getSetting("navigation_order"), DEFAULT_NAVIGATION_ORDER);
    const settingsOrder = parseJson(this.getSetting("settings_order"), DEFAULT_SETTINGS_ORDER);
    const dashboardOrder = parseJson(this.getSetting("dashboard_order"), DEFAULT_DASHBOARD_ORDER);
    return {
      accent: /^#[0-9A-F]{6}$/.test(accent) ? accent : DEFAULT_ACCENT,
      sidebar_mode: this.getSetting("sidebar_mode") === "auto" ? "auto" : "fixed",
      navigation_order: validOrder(navigationOrder, DEFAULT_NAVIGATION_ORDER) ? navigationOrder : [...DEFAULT_NAVIGATION_ORDER],
      settings_order: validOrder(settingsOrder, DEFAULT_SETTINGS_ORDER) ? settingsOrder : [...DEFAULT_SETTINGS_ORDER],
      dashboard_order: validOrder(dashboardOrder, DEFAULT_DASHBOARD_ORDER) ? dashboardOrder : [...DEFAULT_DASHBOARD_ORDER],
    };
  }

  setInterfaceSettings(update) {
    const current = this.getInterfaceSettings();
    const next = { ...current };
    if (update.accent !== undefined) {
      const accent = String(update.accent).toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(accent)) {
        throw domainError(400, "ACCENT_INVALID", "Accent color must use #RRGGBB format");
      }
      const contrast = (relativeLuminance(accent) + 0.05) / 0.05;
      if (contrast < 4.5) {
        throw domainError(400, "ACCENT_CONTRAST_LOW", "Accent color must have at least 4.5:1 contrast on black");
      }
      next.accent = accent;
    }
    if (update.sidebar_mode !== undefined) {
      if (!["fixed", "auto"].includes(update.sidebar_mode)) {
        throw domainError(400, "SIDEBAR_MODE_INVALID", "Sidebar mode must be fixed or auto");
      }
      next.sidebar_mode = update.sidebar_mode;
    }
    if (update.navigation_order !== undefined) {
      if (!validOrder(update.navigation_order, DEFAULT_NAVIGATION_ORDER)) {
        throw domainError(400, "NAVIGATION_ORDER_INVALID", "Navigation order must contain every primary destination exactly once");
      }
      next.navigation_order = [...update.navigation_order];
    }
    if (update.settings_order !== undefined) {
      if (!validOrder(update.settings_order, DEFAULT_SETTINGS_ORDER)) {
        throw domainError(400, "SETTINGS_ORDER_INVALID", "Settings order must contain every section exactly once");
      }
      next.settings_order = [...update.settings_order];
    }
    if (update.dashboard_order !== undefined) {
      if (!validOrder(update.dashboard_order, DEFAULT_DASHBOARD_ORDER)) {
        throw domainError(400, "DASHBOARD_ORDER_INVALID", "Dashboard order must contain every health card exactly once");
      }
      next.dashboard_order = [...update.dashboard_order];
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setSetting("accent_color", next.accent);
      this.setSetting("sidebar_mode", next.sidebar_mode);
      this.setSetting("navigation_order", JSON.stringify(next.navigation_order));
      this.setSetting("settings_order", JSON.stringify(next.settings_order));
      this.setSetting("dashboard_order", JSON.stringify(next.dashboard_order));
      this.setSetting("appearance", "dark");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return next;
  }

  getDashboardStats() {
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage();
    const elapsedMicros = Number(now - this.lastCpuAt) / 1_000;
    const usedMicros = usage.user + usage.system - this.lastCpuUsage.user - this.lastCpuUsage.system;
    const logicalCores = Math.max(cpus().length, 1);
    this.lastCpuAt = now;
    this.lastCpuUsage = usage;
    const cpuPercent = elapsedMicros > 250_000
      ? Math.min(100, Math.max(0, usedMicros / elapsedMicros / logicalCores * 100))
      : null;

    const memoryTotal = totalmem();
    const memoryUsed = Math.max(0, memoryTotal - freemem());
    let disk = null;
    try {
      const value = statfsSync(path.dirname(this.filename));
      const total = Number(value.blocks) * Number(value.bsize);
      const available = Number(value.bavail) * Number(value.bsize);
      const used = Math.max(0, total - available);
      disk = { used_bytes: used, total_bytes: total, percent: total ? used / total * 100 : null };
    } catch {}

    return {
      measured_at: isoNow(),
      entries: Number(this.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE deleted_at IS NULL").get().count),
      cpu: { percent: cpuPercent, logical_cores: logicalCores },
      memory: { used_bytes: memoryUsed, total_bytes: memoryTotal, percent: memoryTotal ? memoryUsed / memoryTotal * 100 : null },
      disk,
      uptime_seconds: Math.floor(process.uptime()),
    };
  }

  audit({ actor, action, target = null, status = "success", details = null }) {
    const event = {
      event_id: randomUUID(),
      actor: String(actor).slice(0, 160),
      action: String(action).slice(0, 120),
      target: target == null ? null : String(target).slice(0, 240),
      status: String(status).slice(0, 40),
      details_json: details == null ? null : JSON.stringify(details),
      created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO audit_events(event_id, actor, action, target, status, details_json, created_at)
      VALUES(@event_id, @actor, @action, @target, @status, @details_json, @created_at)
    `).run(event);
    this.db.prepare(`
      DELETE FROM audit_events WHERE id IN (
        SELECT id FROM audit_events ORDER BY id DESC LIMIT -1 OFFSET ?
      )
    `).run(this.auditRetention);
    return event.event_id;
  }

  listAudit(limit = 100) {
    const rows = this.db.prepare(`
      SELECT event_id, actor, action, target, status, details_json, created_at
      FROM audit_events ORDER BY id DESC LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return rows.map((row) => ({
      event_id: row.event_id,
      actor: row.actor,
      action: row.action,
      target: row.target,
      status: row.status,
      details: row.details_json ? parseJson(row.details_json, {}) : null,
      created_at: row.created_at,
    }));
  }

  #entryRow(entryId, includeDeleted = false) {
    const row = this.db.prepare(`
      SELECT e.*, r.revision_number, r.created_at AS revision_created_at, r.actor AS revision_actor,
             r.reason AS revision_reason, r.source_revision_id,
             r.ciphertext, r.nonce, r.tag
      FROM entries e
      JOIN entry_revisions r ON r.id = e.current_revision_id
      WHERE e.id = ? ${includeDeleted ? "" : "AND e.deleted_at IS NULL"}
    `).get(entryId);
    if (!row) throw domainError(404, "ENTRY_NOT_FOUND", "Entry not found");
    return row;
  }

  #decryptRow(row) {
    const entryKey = unwrapEntryKey(this.masterKey, row.id, row);
    return decryptRevision(entryKey, row.id, row.current_revision_id ?? row.revision_id ?? row.id, row);
  }

  #insertRevision(entryRow, payload, { actor, reason = null, sourceRevisionId = null }) {
    const revisionId = randomUUID();
    const revisionNumber = Number(this.db.prepare(
      "SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM entry_revisions WHERE entry_id = ?",
    ).get(entryRow.id).next);
    const entryKey = unwrapEntryKey(this.masterKey, entryRow.id, entryRow);
    const sealed = encryptRevision(entryKey, entryRow.id, revisionId, payload);
    const createdAt = isoNow();
    this.db.prepare(`
      INSERT INTO entry_revisions(
        id, entry_id, revision_number, parent_revision_id, source_revision_id,
        ciphertext, nonce, tag, actor, reason, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      entryRow.id,
      revisionNumber,
      entryRow.current_revision_id,
      sourceRevisionId,
      sealed.ciphertext,
      sealed.nonce,
      sealed.tag,
      actor,
      reason,
      createdAt,
    );
    this.db.prepare("UPDATE entries SET current_revision_id = ?, updated_at = ?, deleted_at = NULL WHERE id = ?")
      .run(revisionId, createdAt, entryRow.id);
    return { revisionId, revisionNumber, createdAt };
  }

  createEntry(payload, { actor = "operator", reason = "created" } = {}) {
    const entryId = randomUUID();
    const revisionId = randomUUID();
    const { entryKey, wrapped } = createWrappedEntryKey(this.masterKey, entryId);
    const sealed = encryptRevision(entryKey, entryId, revisionId, payload);
    const createdAt = isoNow();
    const position = Number(this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM entries").get().next);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO entries(
          id, current_revision_id, position, wrapped_key, key_nonce, key_tag, created_at, updated_at
        ) VALUES(?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(entryId, position, wrapped.ciphertext, wrapped.nonce, wrapped.tag, createdAt, createdAt);
      this.db.prepare(`
        INSERT INTO entry_revisions(
          id, entry_id, revision_number, parent_revision_id, source_revision_id,
          ciphertext, nonce, tag, actor, reason, created_at
        ) VALUES(?, ?, 1, NULL, NULL, ?, ?, ?, ?, ?, ?)
      `).run(revisionId, entryId, sealed.ciphertext, sealed.nonce, sealed.tag, actor, reason, createdAt);
      this.db.prepare("UPDATE entries SET current_revision_id = ? WHERE id = ?").run(revisionId, entryId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.audit({ actor, action: "entry.create", target: entryId, details: { revision: 1, field_count: payload.fields.length } });
    return this.getEntry(entryId);
  }

  updateEntry(entryId, payload, { expectedRevision, actor = "operator", reason = "updated" } = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#entryRow(entryId);
      if (expectedRevision != null && Number(expectedRevision) !== Number(row.revision_number)) {
        throw domainError(409, "ENTRY_REVISION_CONFLICT", "Entry changed since it was opened");
      }
      const revision = this.#insertRevision(row, payload, { actor, reason });
      this.db.exec("COMMIT");
      this.audit({ actor, action: "entry.update", target: entryId, details: { revision: revision.revisionNumber, field_count: payload.fields.length } });
      return this.getEntry(entryId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listEntries() {
    const rows = this.db.prepare(`
      SELECT e.*, r.revision_number, r.ciphertext, r.nonce, r.tag
      FROM entries e JOIN entry_revisions r ON r.id = e.current_revision_id
      WHERE e.deleted_at IS NULL ORDER BY e.position, e.updated_at DESC
    `).all();
    return rows.map((row) => ({
      id: row.id,
      ...maskPayload(this.#decryptRow(row)),
      revision: Number(row.revision_number),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  listDeletedEntries() {
    const retentionDays = this.getTrashRetentionDays();
    const rows = this.db.prepare(`
      SELECT e.*, r.revision_number, r.ciphertext, r.nonce, r.tag
      FROM entries e JOIN entry_revisions r ON r.id = e.current_revision_id
      WHERE e.deleted_at IS NOT NULL ORDER BY e.deleted_at DESC
    `).all();
    return rows.map((row) => ({
      id: row.id,
      ...maskPayload(this.#decryptRow(row)),
      revision: Number(row.revision_number),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      purge_at: trashDeadline(row.deleted_at, retentionDays),
    }));
  }

  getEntry(entryId) {
    const row = this.#entryRow(entryId);
    return {
      id: row.id,
      ...maskPayload(this.#decryptRow(row)),
      revision: Number(row.revision_number),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getRevisions(entryId) {
    const entry = this.#entryRow(entryId);
    return this.db.prepare(`
      SELECT id, revision_number, parent_revision_id, source_revision_id, actor, reason, created_at
      FROM entry_revisions WHERE entry_id = ? ORDER BY revision_number DESC
    `).all(entry.id).map((row) => ({
      id: row.id,
      revision: Number(row.revision_number),
      parent_revision_id: row.parent_revision_id,
      source_revision_id: row.source_revision_id,
      actor: row.actor,
      reason: row.reason,
      created_at: row.created_at,
      current: row.id === entry.current_revision_id,
    }));
  }

  #revisionRow(entryId, revisionNumber) {
    const entry = this.#entryRow(entryId, true);
    const revision = this.db.prepare(`
      SELECT id AS revision_id, entry_id, revision_number, ciphertext, nonce, tag,
             parent_revision_id, source_revision_id, actor, reason, created_at
      FROM entry_revisions WHERE entry_id = ? AND revision_number = ?
    `).get(entryId, revisionNumber);
    if (!revision) throw domainError(404, "REVISION_NOT_FOUND", "Revision not found");
    return { entry, revision };
  }

  getRevision(entryId, revisionNumber) {
    const { entry, revision } = this.#revisionRow(entryId, revisionNumber);
    const payload = decryptRevision(
      unwrapEntryKey(this.masterKey, entryId, entry),
      entryId,
      revision.revision_id,
      revision,
    );
    return {
      id: revision.revision_id,
      revision: Number(revision.revision_number),
      ...maskPayload(payload),
      parent_revision_id: revision.parent_revision_id,
      source_revision_id: revision.source_revision_id,
      actor: revision.actor,
      reason: revision.reason,
      created_at: revision.created_at,
      current: revision.revision_id === entry.current_revision_id,
    };
  }

  restoreRevision(entryId, revisionNumber, { actor = "operator" } = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { entry, revision } = this.#revisionRow(entryId, revisionNumber);
      const payload = decryptRevision(
        unwrapEntryKey(this.masterKey, entryId, entry),
        entryId,
        revision.revision_id,
        revision,
      );
      const created = this.#insertRevision(entry, payload, {
        actor,
        reason: `restored revision ${revisionNumber}`,
        sourceRevisionId: revision.revision_id,
      });
      this.db.exec("COMMIT");
      this.audit({ actor, action: "entry.restore", target: entryId, details: { source_revision: Number(revisionNumber), revision: created.revisionNumber } });
      return this.getEntry(entryId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revealField(entryId, fieldId, { revisionNumber = null, actor = "operator" } = {}) {
    let payload;
    let revision;
    if (revisionNumber == null) {
      const row = this.#entryRow(entryId);
      payload = this.#decryptRow(row);
      revision = Number(row.revision_number);
    } else {
      const rows = this.#revisionRow(entryId, revisionNumber);
      payload = decryptRevision(
        unwrapEntryKey(this.masterKey, entryId, rows.entry),
        entryId,
        rows.revision.revision_id,
        rows.revision,
      );
      revision = Number(rows.revision.revision_number);
    }
    const field = payload.fields.find((candidate) => candidate.id === fieldId);
    if (!field) throw domainError(404, "FIELD_NOT_FOUND", "Field not found");
    this.audit({ actor, action: "field.reveal", target: `${entryId}/${fieldId}`, details: { revision } });
    return { value: field.value, revision };
  }

  deleteEntry(entryId, { actor = "operator" } = {}) {
    const row = this.#entryRow(entryId);
    const deletedAt = isoNow();
    this.db.prepare("UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(deletedAt, deletedAt, entryId);
    this.audit({ actor, action: "entry.delete", target: entryId, details: { revision: Number(row.revision_number) } });
  }

  restoreDeletedEntry(entryId, { actor = "operator" } = {}) {
    const row = this.#entryRow(entryId, true);
    if (!row.deleted_at) throw domainError(409, "ENTRY_NOT_DELETED", "Entry is not in trash");
    const restoredAt = isoNow();
    const position = Number(this.db.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM entries WHERE deleted_at IS NULL",
    ).get().next);
    this.db.prepare("UPDATE entries SET deleted_at = NULL, updated_at = ?, position = ? WHERE id = ?")
      .run(restoredAt, position, entryId);
    this.audit({ actor, action: "entry.restore_from_trash", target: entryId, details: { deleted_at: row.deleted_at } });
    return this.getEntry(entryId);
  }

  purgeEntry(entryId, { actor = "operator" } = {}) {
    const row = this.#entryRow(entryId, true);
    if (!row.deleted_at) throw domainError(409, "ENTRY_NOT_DELETED", "Delete the entry before purging it");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
      this.audit({ actor, action: "entry.purge", target: entryId, details: { crypto_erasure: true } });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  purgeExpiredEntries({ actor = "system:retention", now = isoNow() } = {}) {
    const retentionDays = this.getTrashRetentionDays();
    const cutoff = new Date(new Date(now).getTime() - retentionDays * DAY_MS).toISOString();
    const rows = this.db.prepare(
      "SELECT id, deleted_at FROM entries WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY deleted_at",
    ).all(cutoff);
    if (!rows.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM entries WHERE id = ?");
      for (const row of rows) {
        remove.run(row.id);
        this.audit({
          actor,
          action: "entry.purge",
          target: row.id,
          details: { crypto_erasure: true, reason: "trash_retention_expired", deleted_at: row.deleted_at },
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return rows.length;
  }

  reorderEntries(ids, { actor = "operator" } = {}) {
    const activeIds = this.db.prepare("SELECT id FROM entries WHERE deleted_at IS NULL").all().map((row) => row.id);
    if (ids.length !== activeIds.length || new Set(ids).size !== ids.length || activeIds.some((id) => !ids.includes(id))) {
      throw domainError(400, "INVALID_ENTRY_ORDER", "Order must include every active entry exactly once");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE entries SET position = ? WHERE id = ?");
      ids.forEach((id, index) => update.run(index, id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.audit({ actor, action: "entry.reorder", details: { entry_count: ids.length } });
  }

  resolveReferences(references, { actor = "service:kernel" } = {}) {
    const unique = [...new Set(references)];
    if (!unique.length || unique.length > 20) throw domainError(400, "INVALID_REFERENCE_BATCH", "Resolve between 1 and 20 references at a time");
    const resolved = [];
    for (const reference of unique) {
      const { entryId, fieldPosition } = parseVoltReference(reference);
      const row = this.#entryRow(entryId);
      const payload = this.#decryptRow(row);
      const field = payload.fields[fieldPosition - 1];
      if (!field) throw domainError(404, "FIELD_NOT_FOUND", `Value position no longer exists for ${reference}`);
      resolved.push({ reference, entryId, fieldPosition, revision: Number(row.revision_number), value: field.value, visibility: field.visibility });
    }
    const resolutionRevision = createHash("sha256")
      .update(resolved.map(({ reference, revision }) => `${reference}@${revision}`).sort().join("\n"))
      .digest("base64url");
    for (const item of resolved) {
      this.audit({
        actor,
        action: "secret.resolve",
        target: `${item.entryId}/${item.fieldPosition}`,
        details: { revision: item.revision },
      });
    }
    return {
      schema: "volt.resolve.v1",
      resolution_revision: resolutionRevision,
      values: Object.fromEntries(resolved.map(({ reference, value, revision, visibility }) => [reference, { value, revision, visibility }])),
    };
  }

  getStats() {
    return {
      entries: Number(this.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE deleted_at IS NULL").get().count),
      revisions: Number(this.db.prepare("SELECT COUNT(*) AS count FROM entry_revisions").get().count),
    };
  }

  exportLogicalState() {
    const tables = {
      settings: this.db.prepare(`
        SELECT key, value FROM settings
        WHERE key NOT IN ('access_key_hash', 'auth_generation', 'kernel_token_hash')
        ORDER BY key
      `).all(),
      entries: this.db.prepare(`
        SELECT id, current_revision_id, position, wrapped_key, key_nonce, key_tag,
               created_at, updated_at, deleted_at FROM entries ORDER BY position, id
      `).all(),
      revisions: this.db.prepare(`
        SELECT id, entry_id, revision_number, parent_revision_id, source_revision_id,
               ciphertext, nonce, tag, actor, reason, created_at
        FROM entry_revisions ORDER BY entry_id, revision_number
      `).all(),
      audit: this.db.prepare(`
        SELECT event_id, actor, action, target, status, details_json, created_at
        FROM audit_events ORDER BY id
      `).all(),
    };
    return tables;
  }

  restoreBackup(inspected, { accessKey = null, actor = "operator" } = {}) {
    if (!inspected.portableSnapshot || !accessKey) {
      return this.importLogicalState(inspected.state, { actor, archiveDigest: inspected.digest });
    }
    const temporary = `${this.filename}.restore-${randomUUID()}`;
    let masterKey;
    try {
      writeFileSync(temporary, inspected.portableSnapshot, { mode: 0o600, flag: "wx" });
      try { masterKey = unlockPortableVault({ filename: temporary, accessKey }).masterKey; }
      catch { throw Object.assign(new Error("Archive Access Key is incorrect or the portable snapshot is damaged"), { status: 400, code: "ARCHIVE_UNLOCK_FAILED" }); }
      const state = { ...inspected.state, entries: inspected.state.entries.map((row) => rewrapEntryKey(masterKey, this.masterKey, row.id, row)) };
      return this.importLogicalState(state, { actor, archiveDigest: inspected.digest });
    } finally {
      masterKey?.fill(0);
      try { unlinkSync(temporary); } catch {}
    }
  }

  importLogicalState(state, { actor = "operator", archiveDigest = null } = {}) {
    const preservedAccessKeyHash = this.getSetting("access_key_hash");
    const preservedKernelTokenHash = this.getSetting("kernel_token_hash");
    const nextAuthGeneration = this.getAuthGeneration() + 1;
    const entryById = new Map(state.entries.map((entry) => [entry.id, entry]));
    const revisionById = new Map(state.revisions.map((revision) => [revision.id, revision]));
    try {
      for (const entry of state.entries) {
        const current = revisionById.get(entry.current_revision_id);
        if (!current || current.entry_id !== entry.id) {
          throw domainError(400, "BACKUP_RELATION_INVALID", "An entry points to a missing current revision");
        }
        const entryKey = unwrapEntryKey(this.masterKey, entry.id, entry);
        for (const revision of state.revisions.filter((candidate) => candidate.entry_id === entry.id)) {
          const payload = decryptRevision(entryKey, entry.id, revision.id, revision);
          if (!payload || payload.schema !== 1 || typeof payload.title !== "string" || !Array.isArray(payload.fields)) {
            throw domainError(400, "BACKUP_CIPHERTEXT_INVALID", "An encrypted entry payload is invalid");
          }
        }
      }
    } catch (error) {
      if (error.code) throw error;
      throw domainError(400, "BACKUP_KEY_MISMATCH", "Backup cannot be opened with the configured master key");
    }
    if (state.revisions.some((revision) => !entryById.has(revision.entry_id))) {
      throw domainError(400, "BACKUP_RELATION_INVALID", "A revision points to a missing entry");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DELETE FROM audit_events;
        UPDATE entries SET current_revision_id = NULL;
        DELETE FROM entry_revisions;
        DELETE FROM entries;
        DELETE FROM settings;
      `);
      const settings = this.db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
      for (const row of state.settings) {
        if (row.key !== "access_key_hash" && row.key !== "auth_generation" && row.key !== "kernel_token_hash") settings.run(row.key, row.value);
      }
      if (preservedAccessKeyHash) settings.run("access_key_hash", preservedAccessKeyHash);
      if (preservedKernelTokenHash) settings.run("kernel_token_hash", preservedKernelTokenHash);
      settings.run("auth_generation", String(nextAuthGeneration));
      const entries = this.db.prepare(`
        INSERT INTO entries(id, current_revision_id, position, wrapped_key, key_nonce, key_tag, created_at, updated_at, deleted_at)
        VALUES(?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of state.entries) entries.run(row.id, row.position, row.wrapped_key, row.key_nonce, row.key_tag, row.created_at, row.updated_at, row.deleted_at);
      const revisions = this.db.prepare(`
        INSERT INTO entry_revisions(id, entry_id, revision_number, parent_revision_id, source_revision_id, ciphertext, nonce, tag, actor, reason, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of state.revisions) revisions.run(row.id, row.entry_id, row.revision_number, row.parent_revision_id, row.source_revision_id, row.ciphertext, row.nonce, row.tag, row.actor, row.reason, row.created_at);
      const setCurrent = this.db.prepare("UPDATE entries SET current_revision_id = ? WHERE id = ?");
      for (const row of state.entries) setCurrent.run(row.current_revision_id, row.id);
      const audit = this.db.prepare(`
        INSERT INTO audit_events(event_id, actor, action, target, status, details_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of state.audit) audit.run(row.event_id, row.actor, row.action, row.target, row.status, row.details_json, row.created_at);
      const integrity = this.db.prepare("PRAGMA foreign_key_check").all();
      if (integrity.length) throw domainError(400, "BACKUP_RELATION_INVALID", "Restored data violates referential integrity");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error.code) throw error;
      throw domainError(400, "BACKUP_RESTORE_FAILED", "Backup restore was rolled back");
    }
    this.audit({ actor, action: "backup.restore", target: archiveDigest, details: { restore_mode: "replace", entry_count: state.entries.length } });
    return this.getStats();
  }
}

export { domainError };
