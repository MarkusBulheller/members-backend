/** Upper bound the UI stepper offers for "Max stints in a row". Enforced server-side only on
 * *changes* (see DriversService.assertMaxStintsAllowed) so existing stored values above it keep
 * saving unchanged. */
export const MAX_SUCCESSIVE_STINTS_CAP = 6;

/** Minimum gap between two iRacing re-syncs of the same driver (idempotency / rate limit). */
export const IRACING_RESYNC_COOLDOWN_MS = 5 * 60 * 1000;

/** Discord's current username format (after normalisation): lowercase letters, digits, "_" and ".". */
export const DISCORD_USERNAME_PATTERN = /^[a-z0-9_.]{2,32}$/;

/** Stored form of a Discord username: trimmed, leading "@" stripped, lower-cased. Non-strings pass
 * through unchanged so validation can reject them. */
export function normalizeDiscordUsername<T>(value: T): T | string {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : value;
}
