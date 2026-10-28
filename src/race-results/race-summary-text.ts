/** Minimal shapes the text builder reads - satisfied by the RaceResult entity with its stints loaded. */
export interface SummaryStintInput {
  driverProfileId: string | null;
  averageLapTimeMs: number | null;
  bestLapTimeMs: number | null;
  incidents: number | null;
  lapsComplete: number | null;
}

export interface SummaryResultInput {
  id: string;
  trackName: string;
  trackConfig: string | null;
  seriesName: string | null;
  startTime: Date | null;
  driverStints: SummaryStintInput[];
}

function positive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

/** "1:32.456" / "58.123" - the way iRacing shows a lap time. */
export function formatLapTimeMs(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const secondsText = seconds.toFixed(3).padStart(6, '0');
  return minutes > 0 ? `${minutes}:${secondsText}` : secondsText;
}

/** "1h 12m" / "38m" / "<1m". */
export function formatDriveMs(ms: number): string {
  if (ms < 60_000) return '<1m';
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The plain-text (Discord markdown) personal race summary sent as a DM, or null when the driver has
 * no stint in the result. Deliberately simpler than the portal's "Your race" panel:
 *  - laps: the driver's lapsComplete (> 0), shown with their share of the team's laps
 *  - drive time: average lap x laps (the same definition the portal's driver stats use)
 *  - average pace vs team: the driver's average lap minus the lap-weighted average of every driver's
 *    average lap (the driver is part of the team average); only shown with at least one teammate
 *  - best lap: bestLapTimeMs, with "fastest of N" / "2nd of N" when at least two drivers have one
 *  - incidents: the driver's own incident count
 * Lines whose data is missing are left out - nothing is guessed.
 */
export function buildRaceSummaryText(
  result: SummaryResultInput,
  driverProfileId: string,
  resultUrl: string,
): string | null {
  const own = result.driverStints.find((s) => s.driverProfileId === driverProfileId);
  if (!own) return null;

  const stints = result.driverStints;
  const ownLaps = positive(own.lapsComplete) ? own.lapsComplete : 0;
  const teamLaps = stints.reduce((total, s) => total + (positive(s.lapsComplete) ? s.lapsComplete : 0), 0);
  const ownAvg = positive(own.averageLapTimeMs) ? own.averageLapTimeMs : null;

  const title = `${result.trackName}${result.trackConfig ? ` - ${result.trackConfig}` : ''}`;
  const context = [result.seriesName, formatDay(result.startTime)].filter(Boolean).join(', ');
  const lines: string[] = [`\u{1F3C1} **Your race: ${title}**${context ? ` (${context})` : ''}`];

  if (ownLaps > 0) {
    const share = teamLaps > 0 ? ` (${Math.round((ownLaps / teamLaps) * 100)}% of the team's laps)` : '';
    const driveMs = ownAvg !== null ? ownAvg * ownLaps : null;
    lines.push(
      `**Laps:** ${ownLaps}${share}${driveMs !== null ? ` · **Drive time:** ${formatDriveMs(driveMs)}` : ''}`,
    );
  }

  if (ownAvg !== null) {
    let line = `**Average lap:** ${formatLapTimeMs(ownAvg)}`;
    const paced = stints.filter((s) => positive(s.averageLapTimeMs) && positive(s.lapsComplete));
    if (stints.length > 1 && paced.length > 0) {
      const pacedLaps = paced.reduce((total, s) => total + (s.lapsComplete as number), 0);
      const teamAvg =
        paced.reduce((total, s) => total + (s.averageLapTimeMs as number) * (s.lapsComplete as number), 0) / pacedLaps;
      const delta = ownAvg - teamAvg;
      if (Math.abs(delta) < 5) {
        line += ' - on the team average';
      } else {
        line += ` - ${(Math.abs(delta) / 1000).toFixed(2)}s ${delta < 0 ? 'faster' : 'slower'} than the team average`;
      }
    }
    lines.push(line);
  }

  if (positive(own.bestLapTimeMs)) {
    let line = `**Best lap:** ${formatLapTimeMs(own.bestLapTimeMs)}`;
    const bests = stints.map((s) => s.bestLapTimeMs).filter(positive);
    if (bests.length > 1) {
      const rank = 1 + bests.filter((b) => b < own.bestLapTimeMs!).length;
      line += rank === 1 ? ` (fastest of ${bests.length})` : ` (${ordinalSuffix(rank)} of ${bests.length})`;
    }
    lines.push(line);
  }

  if (own.incidents !== null && own.incidents >= 0) {
    lines.push(`**Incidents:** ${own.incidents}x`);
  }

  lines.push('', `Full result and your stints: <${resultUrl}>`);
  return lines.join('\n');
}
