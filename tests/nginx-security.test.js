import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const config = fs.readFileSync(new URL("../nginx.security.conf", import.meta.url), "utf8");
const bootstrap = fs.readFileSync(new URL("../scripts/bootstrap.sh", import.meta.url), "utf8");
const releaseWorkflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("public-authenticated Nginx policy has no client IP allow-list", () => {
  assert.doesNotMatch(config, /^\s*(?:allow|deny)\s+/m);
  assert.match(config, /location = \/api\/v1\/internal\/updater\/restore \{ return 404; \}/);
  assert.match(config, /location \^~ \/api\/v1\/internal\/neptune\/ \{ return 404; \}/);
  assert.match(config, /X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex"/);
  assert.match(config, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
});

test("clean-host bootstrap pins exact embedded release trust", () => {
  assert.match(bootstrap, /version="__VOLT_BOOTSTRAP_RELEASE_VERSION__"/);
  assert.match(bootstrap, /embedded_public_key_b64="__VOLT_BOOTSTRAP_PUBLIC_KEY_BASE64__"/);
  assert.doesNotMatch(bootstrap, /api\.github\.com\/repos/);
  assert.doesNotMatch(bootstrap, /"\$base\/volt\.pem"/);
  assert.match(bootstrap, /installed Volt release key differs from this release/);
  assert.match(releaseWorkflow, /--export-public-key release-artifacts\/volt\.pem/);
  assert.match(releaseWorkflow, /build-bootstrap\.mjs/);
});

test("installer preserves Updater trust and never reads Kernel environment", () => {
  const installer = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
  const compose = fs.readFileSync(new URL("../compose.production.yaml", import.meta.url), "utf8");
  for (const service of ["updater", "neptune", "gryphon"]) {
    assert.match(installer, new RegExp(`release-trust/${service}\\.pem`));
  }
  assert.match(installer, /bootstrap-credentials\/volt\.env/);
  assert.match(installer, /stat -c '%u:%a'/);
  assert.match(installer, /rm -f "\$credential_file"/);
  assert.match(installer, /chmod 0660 "\$access_file"/);
  assert.match(compose, /target: \/run\/secrets\/volt-access-key\s+read_only: false/);
  assert.doesNotMatch(installer, /\/opt\/exocortex\/kernel\/\.env/);
});
