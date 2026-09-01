/** What a tiered achievement definition measures. All but MANUAL are auto-computed from
 * RaceResultDriverStint (+ its RaceResult) data via AchievementsService.recalculate() — their
 * tiers require a numeric threshold. MANUAL achievements have no computable metric; tiers are
 * awarded by hand and don't need a threshold.
 *
 * TRACK_WIN additionally requires AchievementDefinition.trackId to be set (which specific track
 * — e.g. "Won Le Mans 24h" only makes sense scoped to one Track row). The others apply globally
 * across every race result and ignore trackId. */
export enum AchievementMetric {
  LAPS = 'LAPS',
  WINS = 'WINS',
  PODIUMS = 'PODIUMS',
  /** Count of distinct cars (by carId, falling back to carName) a driver has raced. */
  DISTINCT_CARS_RACED = 'DISTINCT_CARS_RACED',
  /** Same as DISTINCT_CARS_RACED but only counting cars they've won a race in. */
  DISTINCT_CARS_WON = 'DISTINCT_CARS_WON',
  /** Wins at one specific track — see AchievementDefinition.trackId. */
  TRACK_WIN = 'TRACK_WIN',
  MANUAL = 'MANUAL',
}
