import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FALLBACK_CLAUDE_CODE_VERSION = "1.0.37";
export const RELEASE_URL = "https://api.github.com/repos/anthropics/claude-code/releases/latest";
export const VERSION_CACHE_FILE = "claude-code-version.json";

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const DEFAULT_CACHE_DIR = join(DEFAULT_AGENT_DIR, "extensions", "picc-claude-shim");

function isSemver(value) {
  return /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(value);
}

function normalizeVersion(value) {
  if (typeof value !== "string" || !isSemver(value)) return null;
  return value.startsWith("v") ? value.slice(1) : value;
}

export function versionCachePath(cacheDir = DEFAULT_CACHE_DIR) {
  return join(cacheDir, VERSION_CACHE_FILE);
}

export function readCachedClaudeCodeVersion(cacheDir = DEFAULT_CACHE_DIR) {
  try {
    const cache = JSON.parse(readFileSync(versionCachePath(cacheDir), "utf8"));
    return normalizeVersion(cache.version);
  } catch {
    return null;
  }
}

export function getClaudeCodeVersion(cacheDir = DEFAULT_CACHE_DIR) {
  return readCachedClaudeCodeVersion(cacheDir) ?? FALLBACK_CLAUDE_CODE_VERSION;
}

export function formatClaudeCodeVersion(version = getClaudeCodeVersion()) {
  return `${version} (Claude Code)`;
}

export async function fetchLatestClaudeCodeVersion(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable in this Node.js runtime");
  }
  const response = await fetchImpl(RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "picc-claude-shim",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub releases API returned HTTP ${response.status}`);
  }
  const release = await response.json();
  const version = normalizeVersion(release?.tag_name);
  if (!version) {
    throw new Error("GitHub latest release has no valid semver tag_name");
  }
  return version;
}

export function writeCachedClaudeCodeVersion(version, cacheDir = DEFAULT_CACHE_DIR) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error(`invalid Claude Code version: ${String(version)}`);

  mkdirSync(cacheDir, { recursive: true });
  const path = versionCachePath(cacheDir);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify({ version: normalized }, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
  return normalized;
}

/** Fetch exactly once per package installation; normal shim invocations only read the cache. */
export async function refreshClaudeCodeVersion({ cacheDir = DEFAULT_CACHE_DIR, fetchImpl } = {}) {
  const version = await fetchLatestClaudeCodeVersion(fetchImpl);
  return writeCachedClaudeCodeVersion(version, cacheDir);
}
