/** One stint of the original plan. */
export interface PlanBaselineStint {
  /** The stint's id. A stint deleted later simply no longer matches anything. */
  id: string;
  startsAt: string;
  endsAt: string;
}

/** The plan as it was before the race: what "vs plan" is measured against. It is saved once (by
 * the plan page at the green flag, or by hand) and does not move when the live plan is edited. */
export interface PlanBaseline {
  takenAt: string;
  /** AUTO = the plan page saved it once the race had started; MANUAL = someone pressed "Save original plan". */
  source: 'AUTO' | 'MANUAL';
  stints: PlanBaselineStint[];
}

/** Seconds the latest started stint began after (+) or before (-) the original plan, i.e. the time
 * lost so far. null when no baseline is saved or no started stint is part of it. `stints` in plan order. */
export function driftSecondsAgainst(
  stints: readonly { id: string; actualStartAt: Date | null }[],
  baseline: PlanBaseline | null,
): number | null {
  if (!baseline) return null;
  const startById = new Map(baseline.stints.map((s) => [s.id, Date.parse(s.startsAt)]));
  let drift: number | null = null;
  for (const stint of stints) {
    const planned = startById.get(stint.id);
    if (stint.actualStartAt && planned !== undefined && !Number.isNaN(planned)) {
      drift = Math.round((stint.actualStartAt.getTime() - planned) / 1000);
    }
  }
  return drift;
}
