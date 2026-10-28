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
