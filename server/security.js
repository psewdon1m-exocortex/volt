import {
  argon2Sync,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ARGON_MEMORY_KIB = 64 * 1024;
const ARGON_PASSES = 3;
const ARGON_PARALLELISM = 1;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

export function hashAccessKey(value) {
  const salt = randomBytes(16);
  const derived = argon2Sync("argon2id", {
    message: Buffer.from(value, "utf8"),
    nonce: salt,
    parallelism: ARGON_PARALLELISM,
    tagLength: 32,
    memory: ARGON_MEMORY_KIB,
    passes: ARGON_PASSES,
  });
  return [
    "argon2id",
    "v=19",
    `m=${ARGON_MEMORY_KIB},t=${ARGON_PASSES},p=${ARGON_PARALLELISM}`,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyAccessKey(value, encoded) {
  try {
    const [algorithm, version, parameters, saltValue, expectedValue] = String(encoded).split("$");
    if (algorithm !== "argon2id" || version !== "v=19") return false;
    const values = Object.fromEntries(parameters.split(",").map((part) => part.split("=")));
    const memory = Number(values.m);
    const passes = Number(values.t);
    const parallelism = Number(values.p);
    if (
      !Number.isInteger(memory) || memory < 8192 || memory > 1024 * 1024
      || !Number.isInteger(passes) || passes < 1 || passes > 20
      || !Number.isInteger(parallelism) || parallelism < 1 || parallelism > 16
    ) return false;
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(expectedValue, "base64url");
    const actual = argon2Sync("argon2id", {
      message: Buffer.from(value, "utf8"),
      nonce: salt,
      parallelism,
      tagLength: expected.length,
      memory,
      passes,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionToken(sessionKey, generation, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    sub: "operator",
    generation,
    issued_at: now,
    expires_at: now + SESSION_TTL_MS,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionKey).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySessionToken(token, sessionKey, generation, now = Date.now()) {
  if (typeof token !== "string") return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", sessionKey).update(body).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.sub === "operator"
      && payload.generation === generation
      && Number(payload.expires_at) > now
      ? payload
      : null;
  } catch {
    return null;
  }
}

export function validateRuntimeConfig({ accessKey, masterKey, kernelToken, requireAccessKey = true }) {
  const issues = [];
  if ((requireAccessKey || accessKey != null) && (
    typeof accessKey !== "string"
    || accessKey.length < 12
    || accessKey.length > 512
    || /(?:replace-with|change-this|example-password)/i.test(accessKey)
  )) issues.push("VOLT_ACCESS_KEY must contain between 12 and 512 non-placeholder characters");
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    issues.push("The unlocked Volt vault master key must contain exactly 32 bytes");
  }
  if (kernelToken != null && kernelToken !== "" && (
    typeof kernelToken !== "string"
    || kernelToken.length < 32
    || /(?:replace-with|change-this|example-token)/i.test(kernelToken)
  )) {
    issues.push("VOLT_KERNEL_TOKEN must contain at least 32 non-placeholder characters");
  }
  if (issues.length) throw new Error(issues.join("; "));
}
