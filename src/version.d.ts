/**
 * Type declaration for `version.js` (plain ESM). Keeps tsc happy when TS
 * files import it while jiti loads it at runtime.
 */
export const FALLBACK_CLAUDE_CODE_VERSION: string;
export const RELEASE_URL: string;
export const VERSION_CACHE_FILE: string;
export function versionCachePath(cacheDir?: string): string;
export function readCachedClaudeCodeVersion(cacheDir?: string): string | null;
export function getClaudeCodeVersion(cacheDir?: string): string;
export function formatClaudeCodeVersion(version?: string): string;
export function fetchLatestClaudeCodeVersion(fetchImpl?: typeof fetch): Promise<string>;
export function writeCachedClaudeCodeVersion(version: string, cacheDir?: string): string;
export function refreshClaudeCodeVersion(options?: {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<string>;
