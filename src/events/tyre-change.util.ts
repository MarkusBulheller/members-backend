/** Tyres changed in a single pit stop: 0 (splash and go) to 4 (full change). */
export const MAX_TYRES_PER_STOP = 4;

/** Number of tyres changed in the stop before a stint. `tyresChanged === null` marks a row that
 * predates the per-tyre column — derive 4 when the old boolean said "change", 0 when it did not. */
export function resolveTyresChanged(stint: { tyresChanged: number | null; tyreChange: boolean }): number {
  if (stint.tyresChanged !== null && stint.tyresChanged !== undefined) return stint.tyresChanged;
  return stint.tyreChange ? MAX_TYRES_PER_STOP : 0;
}

/** Resolves the `tyreChange` boolean + `tyresChanged` count to store together, so the two never
 * disagree (tyreChange === tyresChanged > 0). An explicit `tyresChanged` always wins; a bare
 * legacy `tyreChange` only moves the count when it contradicts it (true with 0 tyres → 4, false
 * → 0), otherwise the existing count is kept. Returns null when neither input was given. */
export function reconcileTyreFields(
  input: { tyreChange?: boolean; tyresChanged?: number },
  current: { tyresChanged: number | null; tyreChange: boolean },
): { tyresChanged: number; tyreChange: boolean } | null {
  if (input.tyresChanged !== undefined) {
    return { tyresChanged: input.tyresChanged, tyreChange: input.tyresChanged > 0 };
  }
  if (input.tyreChange !== undefined) {
    const existing = resolveTyresChanged(current);
    const tyresChanged = input.tyreChange === existing > 0 ? existing : input.tyreChange ? MAX_TYRES_PER_STOP : 0;
    return { tyresChanged, tyreChange: input.tyreChange };
  }
  return null;
}

/** LMU: seconds for a stop that changes only 1-2 tyres, used when the team hasn't set its own
 * `partialTyreChangeSeconds`. */
export const PARTIAL_TYRE_CHANGE_SECONDS_DEFAULT = 5;
/** Most tyres a stop can change and still count as a "partial" (fast) tyre change on LMU. */
export const PARTIAL_TYRE_CHANGE_MAX_TYRES = 2;

function toSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The tyre portion of a pit stop, in seconds. iRacing (or an unknown sim) keeps the original
 * all-or-nothing rule: `tyreChange` true -> the team's full `tyreChangeDurationSeconds`. LMU is
 * per tyre: 0 tyres -> 0 s, 1-2 tyres -> the team's `partialTyreChangeSeconds` (fallback 5 s),
 * 3-4 tyres -> the full tyre-change time. Decimal columns arrive as strings. */
export function tyreStopSeconds(
  stint: { tyresChanged?: number | null; tyreChange: boolean },
  team: { tyreChangeDurationSeconds: string | null; partialTyreChangeSeconds?: string | null },
  sim: 'IRACING' | 'LMU' | string | undefined,
): number {
  const full = toSeconds(team.tyreChangeDurationSeconds) ?? 0;
  if (sim !== 'LMU') return stint.tyreChange ? full : 0;
  const tyres = resolveTyresChanged({ tyresChanged: stint.tyresChanged ?? null, tyreChange: stint.tyreChange });
  if (tyres <= 0) return 0;
  if (tyres <= PARTIAL_TYRE_CHANGE_MAX_TYRES) {
    return toSeconds(team.partialTyreChangeSeconds) ?? PARTIAL_TYRE_CHANGE_SECONDS_DEFAULT;
  }
  return full;
}
