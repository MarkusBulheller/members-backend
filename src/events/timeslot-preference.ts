/** Minimal shape of a timeslot needed to order a preference list. */
export interface PreferenceSlot {
  id: string;
  startsAt: Date;
}

/** Normalises a driver's start-time ranking against the slots they actually picked.
 *
 * The result is always a permutation of `chosen`'s ids: requested ids that were not chosen (or
 * are duplicated) are dropped, and chosen slots missing from the request are appended in
 * chronological order. First entry = most preferred. Returns `null` when nothing is chosen, so
 * "no ranking" stays distinguishable from a real one (null = legacy / chronological order). */
export function normalizeTimeslotPreference(
  requested: readonly string[] | null | undefined,
  chosen: readonly PreferenceSlot[],
): string[] | null {
  if (chosen.length === 0) return null;
  const chosenIds = new Set(chosen.map((slot) => slot.id));
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of requested ?? []) {
    if (!chosenIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const rest = chosen
    .filter((slot) => !seen.has(slot.id))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (const slot of rest) {
    if (seen.has(slot.id)) continue; // chosen list itself might repeat an id
    seen.add(slot.id);
    ordered.push(slot.id);
  }
  return ordered;
}
