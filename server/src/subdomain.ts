export const BASE_HOST = "heydeyo.lol";

export const ROOT_HOSTS = ["lokly.heydeyo.lol"];

export const SHARDS = 10;

export function isRootHost(host: string): boolean {
  return ROOT_HOSTS.includes(host);
}

export function generateSubdomain(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function sanitizeSubdomain(raw: string | null): { subdomain?: string; error?: string } {
  if (!raw) return {};
  const s = raw.toLowerCase();
  if (
    s.length < 1 ||
    s.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)
  ) {
    return { error: "Invalid subdomain: must be 1-63 characters, letters, digits and hyphens only (no leading/trailing hyphen)" };
  }
  if (s === "lokly") return { error: "Subdomain 'lokly' is reserved" };
  if (s.endsWith("-lokly")) return { error: "Subdomain cannot end with '-lokly'" };
  return { subdomain: s };
}

export function extractSubdomain(host: string): string | null {
  if (host.endsWith("-lokly.heydeyo.lol")) {
    const prefix = host.slice(0, host.indexOf("-lokly.heydeyo.lol"));
    if (prefix) return prefix;
  }
  const baseParts = BASE_HOST.split(".");
  const parts = host.split(".");
  if (
    parts.length === baseParts.length + 1 &&
    parts.slice(1).join(".") === BASE_HOST
  ) {
    return parts[0];
  }
  for (const root of ROOT_HOSTS) {
    const rootParts = root.split(".");
    if (parts.length === rootParts.length + 1) {
      const subdomain = parts[0];
      const rest = parts.slice(1).join(".");
      if (rest === root) return subdomain;
    }
  }
  return null;
}

export function tunnelUrl(subdomain: string, custom: boolean): string {
  return custom
    ? `https://${subdomain}.heydeyo.lol`
    : `https://${subdomain}-lokly.heydeyo.lol`;
}

export function shardId(subdomain: string): number {
  return subdomain.charCodeAt(0) % SHARDS;
}
