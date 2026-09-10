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
checks the pinned Updater install bundle, and publishes:

- `volt-release.json`;
- `volt-X.Y.Z-compose.tar.gz` and its SHA-256 file;
- `bootstrap.sh`.

The release refuses to replace an existing version tag. Updater resolves only
`volt-v*` GitHub releases and independently verifies the manifest identity,
compose archive checksum, minimum updater version, and immutable image digest.
