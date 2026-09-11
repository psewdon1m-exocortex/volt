import { isIP } from "node:net";
export function trustedProxies(raw = "") {
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const version = isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error("Trusted proxies must be explicit IP addresses or non-universal CIDRs");
    }
  }
  return entries.length ? entries : false;
}
