import "reflect-metadata";
import {
  generateKeyPairSync,
  randomBytes,
  randomInt,
  webcrypto,
} from "node:crypto";
import { isIP } from "node:net";
import {
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
  cryptoProvider,
} from "@peculiar/x509";

cryptoProvider.set(webcrypto);

const ALPHABETS = {
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numbers: "0123456789",
  special: "!#$%&'()*+,-./:;<=>?[\\]^_`{|}~",
};

function log2BigInt(value) {
  const bits = value.toString(2).length;
  if (bits <= 53) return Math.log2(Number(value));
  const shift = bits - 53;
  return Math.log2(Number(value >> BigInt(shift))) + shift;
}

function validStringCount(length, classSizes) {
  const total = classSizes.reduce((sum, size) => sum + size, 0);
  let count = 0n;
  for (let mask = 0; mask < 2 ** classSizes.length; mask += 1) {
    let removed = 0;
    let selected = 0;
    classSizes.forEach((size, index) => {
      if (mask & (1 << index)) {
        removed += size;
        selected += 1;
      }
    });
    const term = BigInt(total - removed) ** BigInt(length);
    count += selected % 2 === 0 ? term : -term;
  }
  return count;
}

function choose(alphabet) {
  return alphabet[randomInt(alphabet.length)];
}

export function generatePassword(options = {}) {
  const length = Number(options.length ?? 24);
  if (!Number.isInteger(length) || length < 4 || length > 256) {
    throw Object.assign(new Error("Password length must be between 4 and 256"), { status: 400 });
  }
  const selected = Object.entries(ALPHABETS)
    .filter(([name]) => options[name] !== false)
    .map(([, value]) => value);
  if (!selected.length) throw Object.assign(new Error("Select at least one character set"), { status: 400 });
  if (length < selected.length) {
    throw Object.assign(new Error("Password length is shorter than the number of required character sets"), { status: 400 });
  }
  const alphabet = selected.join("");
  let value;
  do {
    value = Array.from({ length }, () => choose(alphabet)).join("");
  } while (selected.some((characters) => ![...value].some((character) => characters.includes(character))));
  const entropy = log2BigInt(validStringCount(length, selected.map((item) => item.length)));
  return { kind: "password", value, entropy_bits: Math.round(entropy * 10) / 10, parameters: { ...options, length } };
}

export function generateIdentifier() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return {
    kind: "identifier",
    value: Array.from({ length: 16 }, () => choose(alphabet)).join(""),
    entropy_bits: Math.round(16 * Math.log2(alphabet.length) * 10) / 10,
    parameters: { alphabet: "A-Z0-9", length: 16 },
  };
}

export function generateHmacKey(options = {}) {
  const bytes = Number(options.bytes ?? 32);
  if (![32, 48, 64].includes(bytes)) {
    throw Object.assign(new Error("HMAC key length must be 32, 48 or 64 bytes"), { status: 400 });
  }
  const encoding = options.encoding === "hex" ? "hex" : "base64url";
  return {
    kind: "hmac",
    value: randomBytes(bytes).toString(encoding),
    entropy_bits: bytes * 8,
    parameters: { bytes, encoding },
  };
}

export function generateRsaKeyPair(options = {}) {
  const modulusLength = Number(options.modulus_length ?? 3072);
  if (![2048, 3072, 4096].includes(modulusLength)) {
    throw Object.assign(new Error("RSA modulus must be 2048, 3072 or 4096 bits"), { status: 400 });
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    kind: "rsa",
    values: [
      { key: "private_key", value: privateKey, visibility: "secret" },
      { key: "public_key", value: publicKey, visibility: "plain" },
    ],
    parameters: { modulus_length: modulusLength, private_format: "PKCS#8", public_format: "SPKI" },
  };
}

function pem(label, value) {
  const body = Buffer.from(value).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export async function generateCertificate(options = {}) {
  const commonName = String(options.common_name ?? "localhost").trim();
  const days = Number(options.valid_days ?? 365);
  if (!/^[A-Za-z0-9 ._-]{1,128}$/.test(commonName)) {
    throw Object.assign(new Error("Certificate common name contains unsupported characters"), { status: 400 });
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw Object.assign(new Error("Certificate validity must be between 1 and 3650 days"), { status: 400 });
  }
  const sans = Array.isArray(options.sans) ? options.sans.map((item) => String(item).trim()).filter(Boolean) : [];
  if (sans.length > 20 || sans.some((item) => !/^[A-Za-z0-9.*:_-]{1,253}$/.test(item))) {
    throw Object.assign(new Error("Certificate SAN list is invalid"), { status: 400 });
  }
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const extensions = [
    new BasicConstraintsExtension(false, undefined, true),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
    await SubjectKeyIdentifierExtension.create(keys.publicKey, false, webcrypto),
  ];
  if (sans.length) {
    extensions.push(new SubjectAlternativeNameExtension(sans.map((value) => ({
      type: isIP(value) ? "ip" : "dns",
      value,
    }))));
  }
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${randomBytes(15).toString("hex")}`,
    name: `CN=${commonName}`,
    notBefore,
    notAfter,
    signingAlgorithm: algorithm,
    keys,
    extensions,
  }, webcrypto);
  const privateKey = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    kind: "certificate",
    values: [
      { key: "certificate", value: certificate.toString("pem"), visibility: "plain" },
      { key: "private_key", value: pem("PRIVATE KEY", privateKey), visibility: "secret" },
    ],
    parameters: { algorithm: "ECDSA P-256", common_name: commonName, sans, valid_days: days },
  };
}

function withValues(result, visibility) {
  return result.values ? result : {
    ...result,
    values: [{ key: result.kind, value: result.value, visibility }],
  };
}

export function generateValue(input, options) {
  const kind = typeof input === "string" ? input : input?.type;
  const parameters = typeof input === "string" ? options : input;
  if (kind === "password") return withValues(generatePassword(parameters), "secret");
  if (kind === "identifier") return withValues(generateIdentifier(), "secret");
  if (kind === "hmac") return withValues(generateHmacKey(parameters), "secret");
  if (kind === "rsa") return generateRsaKeyPair(parameters);
  if (kind === "certificate") return generateCertificate(parameters);
  throw Object.assign(new Error("Unknown generator type"), { status: 400 });
}

export { ALPHABETS };
