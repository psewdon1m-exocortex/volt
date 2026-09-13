#!/bin/sh
set -eu

repository="psewdon1m-exocortex/volt"
target="/opt/volt"
version="__VOLT_BOOTSTRAP_RELEASE_VERSION__"
embedded_public_key_b64="__VOLT_BOOTSTRAP_PUBLIC_KEY_BASE64__"

fail() {
  printf '%s\n' "volt bootstrap: $*" >&2
  exit 1
}

[ "$#" -eq 0 ] || fail "this versioned bootstrap accepts no arguments"
[ "$(id -u)" -eq 0 ] || fail "run as root"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "invalid embedded release version"
[ ! -e "$target/.env" ] || fail "Volt is already prepared; use the Settings updater"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl python3 tar
fi
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required for signature verification"
command -v openssl >/dev/null 2>&1 || fail "openssl is required for signature verification"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
base="https://github.com/$repository/releases/download/volt-v$version"
bundle="volt-$version-compose.tar.gz"
trust_file="${EXOCORTEX_RELEASE_TRUST_FILE:-/etc/exocortex/release-trust/volt.pem}"
curl -fL --proto '=https' --proto-redir '=https' --max-filesize 2097152 -o "$work/manifest.json" "$base/volt-release.json"
curl -fL --proto '=https' --proto-redir '=https' --max-filesize 16384 -o "$work/manifest.sig.json" "$base/volt-release.json.sig.json"
printf '%s' "$embedded_public_key_b64" | openssl base64 -d -A >"$work/volt.pem"
openssl pkey -pubin -in "$work/volt.pem" -noout >/dev/null 2>&1 || fail "embedded Volt release key is invalid"
if [ -e "$trust_file" ]; then
  if [ ! -f "$trust_file" ] || [ -L "$trust_file" ] || ! cmp -s "$work/volt.pem" "$trust_file"; then
    fail "installed Volt release key differs from this release"
  fi
fi
python3 - "$work/manifest.json" "$work/manifest.sig.json" "$work/volt.pem" "$version" <<'PYVERIFY'
"""Verify the exact release with the public key embedded in this bootstrap."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

manifest, envelope, trust = map(Path, sys.argv[1:4])
expected_version = sys.argv[4]
if manifest.stat().st_size > 2 * 1024 * 1024 or envelope.stat().st_size > 16384 or trust.stat().st_size > 16384:
    raise SystemExit("Release signature input exceeds limit")
signed = json.loads(envelope.read_text(encoding="utf8"))
if signed.get("schema") != "exocortex.release-signature.v1" or signed.get("algorithm") != "RSA-PSS-SHA256":
    raise SystemExit("Unsupported release signature")
public = subprocess.run(["openssl", "pkey", "-pubin", "-in", str(trust), "-outform", "DER"], check=True, capture_output=True).stdout
if hashlib.sha256(public).hexdigest() != signed.get("key_id"):
    raise SystemExit("Release signer is not trusted")
description = subprocess.run(["openssl", "rsa", "-pubin", "-in", str(trust), "-text", "-noout"], check=True, capture_output=True, text=True).stdout
bits = re.search(r"Public-Key: \((\d+) bit\)", description)
if not bits or int(bits[1]) < 3072:
    raise SystemExit("Release trust requires RSA with at least 3072 bits")
with tempfile.TemporaryDirectory(prefix="exocortex-signature-") as temporary:
    signature = Path(temporary) / "signature.bin"
    signature.write_bytes(base64.b64decode(signed["signature"], validate=True))
    subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(trust), "-signature", str(signature), "-sigopt", "rsa_padding_mode:pss", "-sigopt", "rsa_pss_saltlen:32", str(manifest)], check=True)
data = json.loads(manifest.read_text(encoding="utf8"))
if data.get("service") != "volt" or data.get("version") != expected_version:
    raise SystemExit("Volt release identity mismatch")
PYVERIFY
install -d -o root -g root -m 0755 "$(dirname "$trust_file")"
[ -f "$trust_file" ] || install -o root -g root -m 0644 "$work/volt.pem" "$trust_file"

curl -fL --proto '=https' --tlsv1.2 --retry 3 --max-time 300 -o "$work/$bundle" "$base/$bundle"
python3 - "$work/manifest.json" "$work/$bundle" "$version" <<'PYBUNDLE'
import hashlib, json, re, sys
from pathlib import Path
manifest = json.loads(Path(sys.argv[1]).read_text())
if manifest.get("service") != "volt" or manifest.get("schema_version") != 1 or manifest.get("version") != sys.argv[3]:
    raise SystemExit("Volt release manifest identity mismatch")
expected = str(manifest.get("compose_bundle", {}).get("sha256", "")).removeprefix("sha256:").lower()
if not re.fullmatch("[a-f0-9]{64}", expected):
    raise SystemExit("Invalid signed bundle checksum")
with open(sys.argv[2], "rb") as source:
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
    actual = digest.hexdigest()
if actual != expected:
    raise SystemExit("Volt bundle differs from its signed manifest")
PYBUNDLE

members="$work/members.txt"
tar -tzf "$work/$bundle" > "$members"
count=$(wc -l < "$members" | tr -d ' ')
[ "$count" -le 256 ] || fail "release bundle contains too many members"
awk '
  /^\// { exit 1 }
  /(^|\/)\.\.($|\/)/ { exit 1 }
  /\\/ { exit 1 }
  { if (seen[$0]++) exit 1 }
' "$members" || fail "release bundle contains an unsafe or duplicate path"

stage="$work/stage"
mkdir -p "$stage"
tar -xzf "$work/$bundle" -C "$stage" --no-same-owner --no-same-permissions
for name in compose.production.yaml .env.example README.md install.sh nginx.security.conf updater/install.sh updater/updater-linux-amd64 updater/systemd/updater.service updater/release-trust/updater.pem updater/release-trust/neptune.pem updater/release-trust/gryphon.pem; do
  [ -f "$stage/$name" ] || fail "release bundle is missing $name"
done
mkdir -p "$target"
chmod 0750 "$target"
for name in compose.production.yaml .env.example README.md install.sh nginx.security.conf; do
  install -m 0644 "$stage/$name" "$target/$name"
done
chmod 0755 "$target/install.sh"
install -d -m 0755 "$target/updater/systemd" "$target/updater/release-trust"
install -m 0755 "$stage/updater/install.sh" "$stage/updater/updater-linux-amd64" "$target/updater/"
install -m 0644 "$stage/updater/systemd/updater.service" "$target/updater/systemd/updater.service"
for service in updater neptune gryphon; do
  install -m 0644 "$stage/updater/release-trust/$service.pem" "$target/updater/release-trust/$service.pem"
done
"$target/install.sh" prepare
printf '%s\n' \
  "Release $version is verified and staged in $target." \
  "Edit only the OPERATOR INPUT values in $target/.env." \
  "Then run: sudo volt-install"
