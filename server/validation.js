import { randomUUID } from "node:crypto";

import { domainError } from "./store.js";

function requiredText(value, name, max) {
  if (typeof value !== "string" || !value.trim()) {
    throw domainError(400, "INVALID_ENTRY", `${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw domainError(400, "INVALID_ENTRY", `${name} is too long`);
  return normalized;
}

function optionalText(value, name, max) {
  if (value == null || value === "") return null;
  return requiredText(value, name, max);
}

function cleanGenerator(generator) {
  if (generator == null) return null;
  if (typeof generator !== "object" || Array.isArray(generator)) {
    throw domainError(400, "INVALID_ENTRY", "Generator metadata must be an object");
  }
  const serialized = JSON.stringify(generator);
  if (serialized.length > 4_000) throw domainError(400, "INVALID_ENTRY", "Generator metadata is too large");
  return JSON.parse(serialized);
}

export function normalizeEntryPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw domainError(400, "INVALID_ENTRY", "Entry payload must be an object");
  }
  if (!Array.isArray(body.fields) || body.fields.length < 1 || body.fields.length > 5) {
    throw domainError(400, "INVALID_ENTRY", "Entry must contain between 1 and 5 fields");
  }
  const ids = new Set();
  const fields = body.fields.map((field, index) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw domainError(400, "INVALID_ENTRY", `Field ${index + 1} must be an object`);
    }
    const key = requiredText(field.key, `Field ${index + 1} name`, 64);
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(field.id ?? "")) ? String(field.id).toLowerCase() : randomUUID();
    if (ids.has(id)) throw domainError(400, "INVALID_ENTRY", "Field identifiers must be unique");
    ids.add(id);
    if (typeof field.value !== "string" || !field.value.length) throw domainError(400, "INVALID_ENTRY", `Field ${key} value must not be empty`);
    if (Buffer.byteLength(field.value, "utf8") > 256 * 1024) {
      throw domainError(413, "FIELD_TOO_LARGE", `Field ${key} exceeds 256 KiB`);
    }
    return {
      id,
      key,
      value: field.value,
      visibility: field.visibility === "plain" ? "plain" : "secret",
      generator: cleanGenerator(field.generator),
    };
  });
  return {
    schema: 1,
    title: requiredText(body.title, "Title", 120),
    project: optionalText(body.project, "Project", 80),
    fields,
  };
}

export function normalizeReason(value, fallback) {
  if (value == null || value === "") return fallback;
  return requiredText(value, "Revision note", 240);
}
