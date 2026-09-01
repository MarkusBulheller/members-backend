/** Purely presentational — picks which SVG the frontend renders (see
 * members-portal/src/components/AchievementIcon.tsx for the actual artwork). Kept as a fixed
 * enum rather than free text so the admin form is a picker, not a text field. */
export enum AchievementIcon {
  TROPHY = 'TROPHY',
  FLAG = 'FLAG',
  MEDAL = 'MEDAL',
  ODOMETER = 'ODOMETER',
  STOPWATCH = 'STOPWATCH',
  WHEEL = 'WHEEL',
  STAR = 'STAR',
  SHIELD = 'SHIELD',
  FLAME = 'FLAME',
  CROWN = 'CROWN',
  WRENCH = 'WRENCH',
  BOLT = 'BOLT',
}
