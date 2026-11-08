/** One stint of the schedule as the plan page computes it. */
export interface PublishedPlanStint {
  /** The stint's id: the snapshot only counts while the team's stints are exactly these, in this order. */
  id: string;
  startsAt: string;
  endsAt: string;
  /** Litres in the tank at the start of the stint (what the crew fills to). Null when not computable. */
  fuelLiters: number | null;
  /** Tyres changed at the stop before this stint (0-4); null for the first stint or when unknown. */
  tyres: number | null;
}

/** What the plan page publishes for the follow page and the overlay (see EventTeam.publishedPlan). */
export interface PublishedPlan {
  publishedAt: string;
  stints: PublishedPlanStint[];
}
