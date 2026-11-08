import type { DiscordEmbed } from '../discord-bot/discord-bot.service.js';
import { stintDriveMs } from '../stats/recap.service.js';
import type { IracingResultAttempt } from './iracing-result-attempt.entity.js';

/** Series/track/team names come from iRacing and admins — escape Discord markdown (same set as the
 * event announcement code) so e.g. an underscore doesn't italicise half a name. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>])/g, '\\$1');
}

function positionParts(inClass: number | null, overall: number | null): string[] {
  if (inClass !== null && overall !== null) return [`P${inClass} in class (P${overall} overall)`];
  if (inClass !== null) return [`P${inClass} in class`];
  if (overall !== null) return [`P${overall} overall`];
  return [];
}

export interface ImportedMessageInput {
  id: string;
  seriesName: string | null;
  trackName: string | null;
  finishingPositionInClass: number | null;
  finishingPosition: number | null;
  teamLapsComplete: number | null;
  teamIncidents: number | null;
}

/** "🏁 **Result imported** · series · track · P3 in class (P7 overall) · 120 laps · 4 incidents" + portal link. */
export function buildImportedMessage(result: ImportedMessageInput, frontendUrl: string): string {
  const parts = [
    '🏁 **Result imported**',
    ...(result.seriesName ? [escapeMarkdown(result.seriesName)] : []),
    ...(result.trackName ? [escapeMarkdown(result.trackName)] : []),
    ...positionParts(result.finishingPositionInClass, result.finishingPosition),
    ...(result.teamLapsComplete !== null ? [`${result.teamLapsComplete} laps`] : []),
    ...(result.teamIncidents !== null ? [`${result.teamIncidents} incidents`] : []),
  ];
  return `${parts.join(' · ')}\n<${trimSlash(frontendUrl)}/results/${result.id}>`;
}

/** What the result embed reads off an imported result (the same object the import returns). */
export interface ImportedEmbedInput extends ImportedMessageInput {
  teamName?: string | null;
  carName?: string | null;
  trackConfig?: string | null;
  totalLaps?: number | null;
  splitNumber?: number | null;
  totalSplits?: number | null;
  endTime?: Date | null;
  driverStints?: {
    displayName: string;
    averageLapTimeMs: number | null;
    bestLapTimeMs: number | null;
    incidents: number | null;
    lapsComplete: number | null;
  }[];
}

const EMBED_RED = 0xe10600;
const EMBED_GOLD = 0xf5c542;
const EMBED_SILVER = 0xc0c0c8;
const EMBED_BRONZE = 0xcd7f32;
const MAX_DRIVERS_LISTED = 12;

function formatLapMs(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(3).padStart(6, '0');
  return minutes > 0 ? `${minutes}:${seconds}` : seconds;
}

function formatDriveMs(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/** The imported-result post as a Discord embed: series and track as the title (linking to the
 * result page), the finish, laps, incidents, car and best lap as fields, and each driver's drive
 * time, best lap and incidents. Podium finishes colour the side bar gold / silver / bronze. */
export function buildImportedEmbed(result: ImportedEmbedInput, frontendUrl: string): DiscordEmbed {
  const place = result.finishingPositionInClass ?? result.finishingPosition;
  const color = place === 1 ? EMBED_GOLD : place === 2 ? EMBED_SILVER : place === 3 ? EMBED_BRONZE : EMBED_RED;

  const track = result.trackConfig ? `${result.trackName ?? ''} — ${result.trackConfig}` : (result.trackName ?? null);
  const title = ['🏁', [result.seriesName, track].filter((part): part is string => Boolean(part)).map(escapeMarkdown).join(' — ')]
    .filter(Boolean)
    .join(' ')
    .slice(0, 256);

  const stints = result.driverStints ?? [];
  const bestLap = stints
    .filter((s) => s.bestLapTimeMs !== null && s.bestLapTimeMs > 0)
    .sort((a, b) => (a.bestLapTimeMs as number) - (b.bestLapTimeMs as number))[0];

  const fields: NonNullable<DiscordEmbed['fields']> = [];
  const positions = positionParts(result.finishingPositionInClass, result.finishingPosition);
  if (positions.length > 0) fields.push({ name: 'Result', value: positions.join(' · '), inline: true });
  if (result.teamLapsComplete !== null) {
    const laps = result.totalLaps ? `${result.teamLapsComplete} of ${result.totalLaps}` : String(result.teamLapsComplete);
    fields.push({ name: 'Laps', value: laps, inline: true });
  }
  if (result.teamIncidents !== null) fields.push({ name: 'Incidents', value: String(result.teamIncidents), inline: true });
  if (result.carName) fields.push({ name: 'Car', value: escapeMarkdown(result.carName).slice(0, 1024), inline: true });
  if (bestLap) {
    fields.push({
      name: 'Best lap',
      value: `${formatLapMs(bestLap.bestLapTimeMs as number)} · ${escapeMarkdown(bestLap.displayName)}`.slice(0, 1024),
      inline: true,
    });
  }

  const driverLines = stints.slice(0, MAX_DRIVERS_LISTED).map((s) => {
    const drive = stintDriveMs(s);
    const bits = [
      drive !== null ? formatDriveMs(drive) : null,
      s.bestLapTimeMs !== null && s.bestLapTimeMs > 0 ? `best ${formatLapMs(s.bestLapTimeMs)}` : null,
      s.incidents !== null ? `${s.incidents} inc` : null,
    ].filter((bit): bit is string => bit !== null);
    return `**${escapeMarkdown(s.displayName)}**${bits.length > 0 ? ` — ${bits.join(' · ')}` : ''}`;
  });
  if (stints.length > MAX_DRIVERS_LISTED) driverLines.push(`…and ${stints.length - MAX_DRIVERS_LISTED} more`);
  if (driverLines.length > 0) fields.push({ name: 'Drivers', value: driverLines.join('\n').slice(0, 1024) });

  const footerParts = [
    ...(result.teamName ? [result.teamName] : []),
    ...(result.splitNumber && result.totalSplits ? [`Split ${result.splitNumber}/${result.totalSplits}`] : []),
  ];
  return {
    title,
    url: `${trimSlash(frontendUrl)}/results/${result.id}`,
    color,
    fields,
    ...(footerParts.length > 0 ? { footer: { text: footerParts.join(' · ').slice(0, 2048) } } : {}),
    ...(result.endTime ? { timestamp: result.endTime.toISOString() } : {}),
  };
}

/** NOTIFY mode: "🏁 **New result available** · series · track · P3 in class · team — an admin can import it …". */
export function buildFoundMessage(attempt: IracingResultAttempt, teamName: string | null, frontendUrl: string): string {
  const parts = [
    '🏁 **New result available**',
    ...(attempt.seriesName ? [escapeMarkdown(attempt.seriesName)] : []),
    ...(attempt.trackName ? [escapeMarkdown(attempt.trackName)] : []),
    ...(attempt.finishingPositionInClass !== null
      ? [`P${attempt.finishingPositionInClass} in class`]
      : attempt.finishingPosition !== null
        ? [`P${attempt.finishingPosition} overall`]
        : []),
    ...(teamName ? [escapeMarkdown(teamName)] : []),
  ];
  return `${parts.join(' · ')} — an admin can import it in the portal: <${trimSlash(frontendUrl)}/admin/settings/auto-import>`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
