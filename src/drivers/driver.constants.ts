/** Upper bound the UI stepper offers for "Max stints in a row". Enforced server-side only on
 * *changes* (see DriversService.assertMaxStintsAllowed) so existing stored values above it keep
 * saving unchanged. */
export const MAX_SUCCESSIVE_STINTS_CAP = 6;

/** Minimum gap between two iRacing re-syncs of the same driver (idempotency / rate limit). */
export const IRACING_RESYNC_COOLDOWN_MS = 5 * 60 * 1000;
