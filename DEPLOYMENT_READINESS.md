# volt deployment and recovery contract

This service-local record is subordinate to the coordinated
[Part 11 deployment profile](https://github.com/psewdon1m-exocortex/general/blob/main/PART_11_INITIAL_MULTI_SERVICE_DEPLOYMENT.md)
and the shared-agent contracts in
[Part 09](https://github.com/psewdon1m-exocortex/general/blob/main/PART_09_SERVICE_AGENTS_DEPLOYMENT_AND_LIFECYCLE.md) and
[Part 10](https://github.com/psewdon1m-exocortex/general/blob/main/PART_10_SERVICE_AGENTS_UI_AND_OPERATOR_WORKFLOWS.md).

Access Key unlock is mandatory. A protected Access Key file is an explicitly supplied key; a device wrapper alone never authorizes startup. The key is opaque exact text with no length, composition, character-set, URL-safe/ASCII, strength/entropy or value-denylist policy and no trimming or normalization. Without a supplied key, the locked UI remains reachable and readiness is unavailable until login. The current 12–512-character, placeholder and file-trimming behavior is a release-blocking `BST-13` implementation gap. Recovery ZIP v3 contains portable personal.volt plus validated logical state; clean restore opens the archived vault with its Access Key and rewraps entries into the target vault. Saturn retains both backups/volt archives and an independent volt/personal.volt mirror. Settings can initialize both Neptune pipelines even when the helper is absent.

## Trust and operator prerequisites

The selected deployment profile contains Kernel, Volt, Saturn, Updater, Neptune and Gryphon. Per-host helpers are reused when healthy; attaching a service does not silently downgrade or reinstall them. Operator control is available through connected service Settings and typed CLI actions. Jobs retain their identifiers across page reloads and must reach a verified terminal result.

Release manifests use detached RSA-PSS-SHA256 signatures with a per-project RSA key of at least 3072 bits. Keep Volt's private key only in GitHub Secrets and expose it only to the protected release-signing job. CI derives the public counterpart and embeds it in Volt's versioned `bootstrap.sh`; bootstrap creates `/etc/exocortex/release-trust/volt.pem`, verifies the manifest before downloading the service, and never replaces an existing mismatching key automatically. No `scp`, manual release-key fingerprint or separately downloaded public key is part of this trust path. Saturn also retains its Ed25519 installer signature. The six-service head bundles require Updater 0.4.3 or newer.

Populate actual Kernel/Volt bootstrap coordinates, service tokens, SFTP host fingerprint, canonical HTTPS origins and exact server-Nginx proxy hops. Volt has its own bootstrap and mode-`0600` `.env`; neither is shared with another service. Its locked/login UI is public-authenticated and reachable from every client IP: do not introduce `OPERATOR_CIDR`, a VPN prerequisite or an IP allow-list. Access Key validation and bounded application sessions protect all vault data. Volt runs no embedded Nginx and uses no coturn; a genuine future WebRTC NAT-traversal feature requires a separate reviewed TURN decision. Secrets must not appear in links, responses, browser persistence or logs. Public login pages remain non-indexable; crawler directives are not an authentication boundary. Resolve service data and generated link origins through Kernel; bootstrap trust and local loopback helper endpoints are explicit exceptions.

## Recovery boundaries

Keep the Access Key and helper-recovery passphrase separately from their archives. Main-service recovery retains user settings and application data while preserving or requiring re-enrollment of external host trust. The encrypted helper profile is controlled by Updater and contains Neptune/Gryphon state and credentials plus Updater job/rollback history. It excludes executable files, release trust keys, systemd units and head deployment environments. Install trusted software and register target heads before restoring. The bounded helper archive fails explicitly at 128 MiB expanded or 10000 files; it never silently omits data.

## Acceptance evidence

The seven-area policy in .github/pre-push-gate.json is required after native CI verification. Public indexing is intentionally not applicable. For an uncommitted local review run the gate with --worktree after the native checks. Gate PASS checks policy/evidence/verification linkage; it is not a substitute for executing the integration scenarios.

Qualify the connected system with real HTTP Kernel→Volt authentication, clean archives/restores, PostgreSQL and pinned SFTP, independent Volt mirror, Windows folder synchronization, network interruption/replay, signed artifact rejection, unauthenticated-edge negative cases and helper installation/reuse. Record PASS, FAIL and NOT_RUN separately. Production credentials, signed publication and actual deployment remain operator provisioning operations.

See [README](README.md) for service commands.
