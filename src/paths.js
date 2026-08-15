import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

// Bump this when the CLI and detached server no longer share the same request
// contract. A new CLI must not silently reuse an older background server.
export const SERVER_PROTOCOL = 8;

export function stateDir() {
  const override = process.env.HUMAN_REVIEW_STATE_DIR;
  return override ? path.resolve(override) : path.join(homedir(), ".human-review");
}

export function statePath() {
  return path.join(stateDir(), "state.json");
}

export function serverPath() {
  return path.join(stateDir(), "server.json");
}

export function ensureStateDir() {
  // Comments and the server token live here; keep it private to the user.
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Return a canonical loopback URL, or null when the input is a filesystem path.
 * HTTP-looking non-loopback targets fail loudly instead of becoming odd paths.
 */
export function localUrl(target) {
  const value = String(target || "");
  if (!/^https?:\/\//i.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid localhost URL: ${value}`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("human-review URL support is limited to localhost, 127.0.0.1, and [::1].");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Localhost review URLs cannot contain credentials.");
  }
  parsed.hash = "";
  return parsed.href;
}

/** Canonical identity for a page: the real path of the file on disk. */
export function pageKey(file) {
  let real = path.resolve(file);
  try {
    real = fs.realpathSync(real);
  } catch {
    // File may not exist yet; the resolved path is still a stable identity.
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/** Stable identity for either an existing file target or a localhost URL. */
export function targetKey(target) {
  const url = localUrl(target);
  if (!url) return pageKey(target);
  return createHash("sha256").update(`url:${url}`).digest("hex").slice(0, 16);
}

export function canonicalTarget(target) {
  const url = localUrl(target);
  return url ? { kind: "url", value: url } : { kind: "file", value: realFile(target) };
}

export function realFile(file) {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
