const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Parses simple durations like "7d", "12h", "30m", "45s" (or a plain number of seconds)
 * into milliseconds. Kept local rather than pulling in the `ms` package for one conversion. */
export function parseDurationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
      return asNumber * 1000;
    }
    throw new Error(`Invalid duration string: ${value}`);
  }

  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit];
}
