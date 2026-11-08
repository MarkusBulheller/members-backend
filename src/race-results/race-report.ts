import { escapeMarkdown } from '../discord-bot/discord-bot.service.js';
import { formatDriveMs, formatLapTimeMs } from './race-summary-text.js';

export interface ReportStint {
  displayName: string;
  averageLapTimeMs: number | null;
  bestLapTimeMs: number | null;
  incidents: number | null;
  lapsComplete: number | null;
}

/** What the report reads off an imported result (the RaceResult entity with its driver stints loaded). */
export interface ReportResultInput {
  seriesName: string | null;
  trackName: string;
  trackConfig: string | null;
  carName: string | null;
  teamName?: string | null;
  startTime: Date | null;
  endTime: Date | null;
  startingPosition: number | null;
  finishingPosition: number | null;
  startingPositionInClass: number | null;
  finishingPositionInClass: number | null;
  teamLapsComplete: number | null;
  teamIncidents: number | null;
  driverStints: ReportStint[];
}

export interface RaceReport {
  /** Discord markdown, within Discord's 2000 characters. */
  discord: string;
  /** Plain text for a social post, within 280 characters. */
  short: string;
}

export const DISCORD_LIMIT = 2000;
export const SHORT_LIMIT = 280;
/** A driver needs this many laps before their incidents count for "cleanest drive". */
export const CLEANEST_MIN_LAPS = 20;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function positive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function driveMs(stint: ReportStint): number | null {
  return positive(stint.averageLapTimeMs) && positive(stint.lapsComplete) ? stint.averageLapTimeMs * stint.lapsComplete : null;
}

/** The facts a report is made of: only what the result really says; anything missing is null. */
export interface ReportFacts {
  title: string;
  date: string | null;
  carName: string | null;
  teamName: string | null;
  /** "P3 in class (P7 overall)" / "P7 overall" / null. */
  placeText: string | null;
  /** Finish position in the scope the place is told in (class when there is one). */
  place: number | null;
  /** Places gained (+) or lost (-) from the start, in the same scope as `place`; null when unknown. */
  placesGained: number | null;
  startText: string | null;
  laps: number | null;
  incidents: number | null;
  /** Drivers by time in the car, longest first. */
  drivers: { name: string; driveMs: number | null }[];
  mostDriven: { name: string; driveMs: number } | null;
  fastestLap: { name: string; ms: number } | null;
  cleanest: { name: string; incidents: number; laps: number } | null;
}

export function reportFacts(result: ReportResultInput): ReportFacts {
  const track = result.trackConfig ? `${result.trackName} - ${result.trackConfig}` : result.trackName;
  const title = [result.seriesName, track].filter((part): part is string => Boolean(part)).join(' · ');

  const finishClass = positive(result.finishingPositionInClass) ? result.finishingPositionInClass : null;
  const finishOverall = positive(result.finishingPosition) ? result.finishingPosition : null;
  const startClass = positive(result.startingPositionInClass) ? result.startingPositionInClass : null;
  const startOverall = positive(result.startingPosition) ? result.startingPosition : null;

  let placeText: string | null = null;
  if (finishClass !== null) placeText = `P${finishClass} in class${finishOverall !== null ? ` (P${finishOverall} overall)` : ''}`;
  else if (finishOverall !== null) placeText = `P${finishOverall} overall`;

  const place = finishClass ?? finishOverall;
  // Compare start and finish in the same scope.
  const start = finishClass !== null ? startClass : startOverall;
  const placesGained = place !== null && start !== null ? start - place : null;
  const startText = start !== null ? `P${start}` : null;

  const stints = result.driverStints ?? [];
  const drivers = stints
    .map((stint) => ({ name: stint.displayName, driveMs: driveMs(stint) }))
    .sort((a, b) => (b.driveMs ?? -1) - (a.driveMs ?? -1));
  const most = drivers[0];
  const mostDriven = drivers.length >= 2 && most && most.driveMs !== null ? { name: most.name, driveMs: most.driveMs } : null;

  const fastest = stints
    .filter((s) => positive(s.bestLapTimeMs))
    .sort((a, b) => (a.bestLapTimeMs as number) - (b.bestLapTimeMs as number))[0];

  // Cleanest drive: lowest incidents per lap among drivers with enough laps; needs a comparison.
  const eligible = stints.filter(
    (s) => s.incidents !== null && s.incidents >= 0 && positive(s.lapsComplete) && s.lapsComplete >= CLEANEST_MIN_LAPS,
  );
  let cleanest: ReportFacts['cleanest'] = null;
  if (eligible.length >= 2) {
    const best = [...eligible].sort(
      (a, b) =>
        (a.incidents as number) / (a.lapsComplete as number) - (b.incidents as number) / (b.lapsComplete as number) ||
        (b.lapsComplete as number) - (a.lapsComplete as number),
    )[0];
    cleanest = { name: best.displayName, incidents: best.incidents as number, laps: best.lapsComplete as number };
  }

  const when = result.endTime ?? result.startTime;
  const date = when && !Number.isNaN(when.getTime()) ? `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]} ${when.getUTCFullYear()}` : null;

  return {
    title,
    date,
    carName: result.carName,
    teamName: result.teamName ?? null,
    placeText,
    place,
    placesGained,
    startText,
    laps: positive(result.teamLapsComplete) ? result.teamLapsComplete : null,
    incidents: result.teamIncidents !== null && result.teamIncidents >= 0 ? result.teamIncidents : null,
    drivers,
    mostDriven,
    fastestLap: fastest ? { name: fastest.displayName, ms: fastest.bestLapTimeMs as number } : null,
    cleanest,
  };
}

function emojiFor(place: number | null): string {
  return place === 1 ? '🏆' : place === 2 ? '🥈' : place === 3 ? '🥉' : '🏁';
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "from P9, up 6 places" / "from P4, down 2 places" / "from P5, holding the place". */
function startPhrase(facts: ReportFacts): string | null {
  if (facts.startText === null || facts.placesGained === null) return null;
  const n = Math.abs(facts.placesGained);
  if (facts.placesGained > 0) return `from ${facts.startText}, up ${n} ${n === 1 ? 'place' : 'places'}`;
  if (facts.placesGained < 0) return `from ${facts.startText}, down ${n} ${n === 1 ? 'place' : 'places'}`;
  return `from ${facts.startText}, holding the place`;
}

function incidentsPhrase(incidents: number): string {
  return incidents === 0 ? 'a clean race: no incidents' : `${incidents} ${incidents === 1 ? 'incident' : 'incidents'}`;
}

/** A ready-to-edit race report from an imported result, for Discord and for a short social post.
 * Built from a fixed template out of facts the result states; lines whose data is missing are left out.
 * `resultUrl` is a public link to the result (the result's share link) or null. */
export function buildRaceReport(result: ReportResultInput, resultUrl: string | null): RaceReport {
  const facts = reportFacts(result);
  const emoji = emojiFor(facts.place);
  const names = facts.drivers.map((d) => d.name);

  // ---- Discord ------------------------------------------------------------------------------------
  const lines: string[] = [`${emoji} **${escapeMarkdown(facts.title)}**${facts.date ? ` · ${facts.date}` : ''}`];
  const who = [facts.teamName, facts.carName].filter((part): part is string => Boolean(part));
  if (who.length > 0) lines.push(who.map(escapeMarkdown).join(' · '));

  if (facts.placeText) {
    const phrase = startPhrase(facts);
    lines.push(`We finished **${facts.placeText}**${phrase ? `, ${phrase}` : ''}.`);
  }
  const numbers = [
    facts.laps !== null ? `${facts.laps} laps` : null,
    facts.incidents !== null ? incidentsPhrase(facts.incidents) : null,
  ].filter((part): part is string => part !== null);
  if (numbers.length > 0) lines.push(`${numbers.join(' with ')}.`);

  if (names.length > 0) {
    let drove = `Driven by ${joinNames(names.map(escapeMarkdown))}.`;
    if (facts.mostDriven) drove += ` Most time in the car: ${escapeMarkdown(facts.mostDriven.name)} (${formatDriveMs(facts.mostDriven.driveMs)}).`;
    lines.push(drove);
  }
  if (facts.fastestLap) lines.push(`⚡ Fastest lap: ${escapeMarkdown(facts.fastestLap.name)}, ${formatLapTimeMs(facts.fastestLap.ms)}`);
  if (facts.cleanest) {
    lines.push(
      `🧼 Cleanest drive: ${escapeMarkdown(facts.cleanest.name)}, ${facts.cleanest.incidents} ${facts.cleanest.incidents === 1 ? 'incident' : 'incidents'} in ${facts.cleanest.laps} laps`,
    );
  }
  if (resultUrl) lines.push(resultUrl);
  const discord = lines.join('\n').slice(0, DISCORD_LIMIT);

  // ---- short ---------------------------------------------------------------------------------------
  const headline = `${emoji} ${[result.seriesName, result.trackName].filter(Boolean).join(' at ')}`;
  const pieces: string[] = [];
  if (facts.placeText) {
    const phrase = startPhrase(facts);
    pieces.push(`${facts.placeText}${phrase ? ` ${phrase}` : ''}.`);
  }
  if (facts.laps !== null) pieces.push(`${facts.laps} laps${names.length > 1 ? `, ${names.length} drivers` : ''}.`);
  if (facts.fastestLap) pieces.push(`Fastest lap ${formatLapTimeMs(facts.fastestLap.ms)} (${facts.fastestLap.name}).`);
  if (facts.incidents === 0) pieces.push('Clean race!');
  const link = resultUrl ? ` ${resultUrl}` : '';
  // Drop the least important pieces from the end until it fits (the link and the headline stay).
  const compose = (list: string[]) => `${[headline + ':', ...list].join(' ').replace(/: $/, ':')}${link}`.trim();
  const kept = [...pieces];
  while (compose(kept).length > SHORT_LIMIT && kept.length > 0) kept.pop();
  let short = compose(kept);
  if (short.length > SHORT_LIMIT) short = `${headline.slice(0, Math.max(0, SHORT_LIMIT - link.length - 1))}…${link}`;
  return { discord, short };
}
