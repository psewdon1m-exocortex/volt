import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const config = fs.readFileSync(new URL("../nginx.security.conf", import.meta.url), "utf8");

test("public-authenticated Nginx policy has no client IP allow-list", () => {
  assert.doesNotMatch(config, /^\s*(?:allow|deny)\s+/m);
  assert.match(config, /location = \/api\/v1\/internal\/updater\/restore \{ return 404; \}/);
  assert.match(config, /location \^~ \/api\/v1\/internal\/neptune\/ \{ return 404; \}/);
  assert.match(config, /X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex"/);
  assert.match(config, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
});
