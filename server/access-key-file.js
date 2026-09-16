import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";

function assertAccessKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Access Key must be supplied");
  }
}

export function readAccessKeyFile(filename) {
  return readFileSync(filename, "utf8");
}

// Volt 0.1.5 wrote one trailing line ending and then trimmed the file while
// reading it. Keep this compatibility candidate separate from normal unlocks:
// browser and offline Access Keys continue to use exact string semantics.
export function legacyInstallerAccessKey(value) {
  if (typeof value !== "string" || !value.endsWith("\n")) return null;
  const candidate = value.trim();
  return candidate && candidate !== value ? candidate : null;
}

// The production path is a bind-mounted regular file, so rename(2) cannot
// replace the mount point. Update the existing inode, flush it, and preserve
// ownership/mode established by the installer.
export function writeAccessKeyFile(filename, accessKey) {
  assertAccessKey(accessKey);
  const descriptor = openSync(filename, constants.O_WRONLY);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Access Key path is not a regular file");
    const bytes = Buffer.from(accessKey, "utf8");
    ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
