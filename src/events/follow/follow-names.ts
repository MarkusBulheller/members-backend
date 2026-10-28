/** How driver names are shown on the public "Follow the race" page / overlay. */
export const FOLLOW_NAMES_MODES = ['FULL', 'FIRST', 'INITIALS'] as const;
export type FollowNamesMode = (typeof FOLLOW_NAMES_MODES)[number];

export function isFollowNamesMode(value: unknown): value is FollowNamesMode {
  return typeof value === 'string' && (FOLLOW_NAMES_MODES as readonly string[]).includes(value);
}

/** Applies a team's chosen names mode to a driver's display name (the iRacing / planner name).
 * FULL = as is, FIRST = first word, INITIALS = "A. R." style (one initial per word). A blank or
 * missing name stays null. An unknown stored mode falls back to INITIALS, the most private one. */
export function formatFollowName(name: string | null | undefined, mode: string): string | null {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  switch (mode) {
    case 'FULL':
      return words.join(' ');
    case 'FIRST':
      return words[0];
    default:
      return words.map((w) => `${Array.from(w)[0].toUpperCase()}.`).join(' ');
  }
}
