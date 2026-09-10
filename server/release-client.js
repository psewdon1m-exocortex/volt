const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(value) {
  const match = SEMVER.exec(String(value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""] : null;
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  if (left[3] === right[3]) return 0;
  if (!left[3]) return 1;
  if (!right[3]) return -1;
  return left[3].localeCompare(right[3]);
}

function githubCoordinates(repositoryUrl, label = "release") {
  let parsed;
  try { parsed = new URL(repositoryUrl); }
  catch { throw Object.assign(new Error(`${label} repository URL is invalid`), { status: 409, code: "RELEASE_REPOSITORY_INVALID" }); }
  const segments = parsed.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || segments.length !== 2) {
    throw Object.assign(new Error(`${label} repository must identify an HTTPS GitHub repository`), { status: 409, code: "RELEASE_REPOSITORY_INVALID" });
  }
  return { owner: segments[0], repository: segments[1], url: `https://github.com/${segments[0]}/${segments[1]}` };
}

async function boundedJson(response, maximumBytes, description) {
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) throw Object.assign(new Error(`${description} is too large`), { status: 502 });
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error(`${description} is invalid`), { status: 502 }); }
}

export async function resolveRepositoryUrl({ kernelUrl, kernelServiceToken, key, version, fetchImpl = globalThis.fetch, timeoutMs = 5_000 }) {
  if (!kernelUrl || !kernelServiceToken) {
    throw Object.assign(new Error("Kernel Register access is not configured for release discovery"), { status: 503, code: "KERNEL_REGISTER_NOT_CONFIGURED" });
  }
  let origin;
  try {
    const parsed = new URL(kernelUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    origin = parsed.origin;
  } catch {
    throw Object.assign(new Error("KERNEL_URL is invalid"), { status: 503, code: "KERNEL_REGISTER_NOT_CONFIGURED" });
  }
  const response = await fetchImpl(`${origin}/api/v1/register/resolve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kernelServiceToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `exocortex-volt/${version}`,
    },
    body: JSON.stringify({ keys: [key] }),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw Object.assign(new Error(`Kernel Register returned HTTP ${response.status}`), { status: 502, code: "KERNEL_REGISTER_UNAVAILABLE" });
  const payload = await boundedJson(response, 1024 * 1024, "Kernel Register response");
  const resolved = payload?.values?.[key]?.value;
  if (payload?.schema !== "exocortex.register.resolution.v1" || typeof resolved !== "string") {
    throw Object.assign(new Error(`Kernel Register omitted ${key}`), { status: 409, code: "RELEASE_REPOSITORY_MISSING" });
  }
  return githubCoordinates(resolved, key).url;
}

export async function checkGithubRelease({ repositoryUrl, service, currentVersion, fetchImpl = globalThis.fetch, timeoutMs = 5_000 }) {
  const { owner, repository, url } = githubCoordinates(repositoryUrl, `repositories.${service}.url`);
  const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `exocortex-${service}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub releases returned HTTP ${response.status}`), { status: 502, code: "RELEASE_DISCOVERY_FAILED" });
  const releases = await boundedJson(response, 4 * 1024 * 1024, "GitHub releases response");
  if (!Array.isArray(releases)) throw Object.assign(new Error("GitHub releases response is invalid"), { status: 502 });
  const prefix = `${service}-v`;
  const candidates = releases
    .filter((release) => !release?.draft && !release?.prerelease && String(release?.tag_name ?? "").toLowerCase().startsWith(prefix.toLowerCase()))
    .map((release) => ({ release, version: String(release.tag_name).slice(prefix.length) }))
    .filter((item) => parseVersion(item.version))
    .sort((left, right) => compareVersions(right.version, left.version));
  const available = candidates.find((item) => compareVersions(item.version, currentVersion) > 0);
  return {
    service,
    repository_url: url,
    installed_version: currentVersion,
    available_version: available?.version ?? null,
    update_available: Boolean(available),
    release_url: available?.release?.html_url ?? null,
    published_at: available?.release?.published_at ?? null,
    backup_required: service === "volt",
  };
}

export async function checkRegisteredRelease({ kernelUrl, kernelServiceToken, service, currentVersion, version, fetchImpl = globalThis.fetch, timeoutMs = 5_000 }) {
  const repositoryUrl = await resolveRepositoryUrl({
    kernelUrl,
    kernelServiceToken,
    key: `repositories.${service}.url`,
    version,
    fetchImpl,
    timeoutMs,
  });
  return checkGithubRelease({ repositoryUrl, service, currentVersion, fetchImpl, timeoutMs });
}
