# Releasing Volt

1. Update `package.json` and `package-lock.json` to the same semantic version.
2. Keep `.release/updater.version` pinned to an existing checksummed Updater
   release.
3. Ensure Kernel Register resolves `repositories.volt.url` to this repository and
   `repositories.updater.url` to the Updater repository.
4. Run `npm ci --ignore-scripts`, `npm audit --omit=dev --audit-level=high`, and
   `npm run check`.
5. Push an annotated `volt-vX.Y.Z` tag whose version matches `package.json`.

The release workflow builds and publishes one candidate image, smoke-tests that
exact digest, promotes it to immutable version and `latest` tags, downloads and
checks the pinned Updater install bundle, and builds:

- `volt-release.json`;
- `volt-X.Y.Z-compose.tar.gz` and its SHA-256 file;
- `bootstrap.sh`.

The protected signing job reads Volt's private release key only from GitHub
Secrets, signs `volt-release.json`, derives the public counterpart and embeds
only that public key in the versioned `bootstrap.sh`. CI verifies the
signature, checksums and absence of private-key bytes before publication. On a
clean host bootstrap creates `/etc/exocortex/release-trust/volt.pem` and Volt's
separate mode-`0600` `.env`, then verifies the manifest before any service
download. It must not depend on `scp`, a manual release-key fingerprint or a
public key downloaded beside the manifest.

The embedded Updater bundle must contain `release-trust/updater.pem`,
`release-trust/neptune.pem` and `release-trust/gryphon.pem`.

The release refuses to replace an existing version tag. Updater resolves only
`volt-v*` GitHub releases and independently verifies the manifest identity,
compose archive checksum, minimum updater version, and immutable image digest.
