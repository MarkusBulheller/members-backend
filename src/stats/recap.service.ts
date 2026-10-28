import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { IracingTeam } from '../iracing/iracing-team.entity.js';
import { RaceResultDriverStint } from '../race-results/race-result-driver-stint.entity.js';
import { RaceResult } from '../race-results/race-result.entity.js';

export type RecapAwardKey = 'iron-driver' | 'lap-leader' | 'fastest-lap' | 'cleanest' | 'most-stints';

export interface RecapGroupStat {
  id: string | null;
  name: string;
  races: number;
  bestFinish: number | null;
}

export interface RecapDriver {
  driverProfileId: string | null;
  name: string;
  races: number;
  laps: number;
  driveMs: number;
  bestLapMs: number | null;
  incidents: number;
  stints: number;
}

export interface RecapAward {
  key: RecapAwardKey;
  title: string;
  driverName: string;
  value: string;
  detail: string | null;
}

export interface RecapStats {
  year: number;
  teamId: number | null;
  teamName: string | null;
  availableYears: number[];
  teams: { teamId: number; teamName: string }[];
  totals: {
    races: number;
    laps: number;
    driveMs: number;
    wins: number;
    podiums: number;
    topTens: number;
    incidents: number;
    avgFinish: number | null;
    bestFinish: number | null;
    avgIncidentsPerRace: number | null;
  };
  longestRace: {
    resultId: string;
    trackName: string;
    seriesName: string | null;
    lapsComplete: number;
    driveMs: number | null;
    /** Wall-clock length (end - start) when the result has both; additive to the agreed shape. */
    durationMs: number | null;
    date: string;
  } | null;
  bestResult: {
    resultId: string;
    trackName: string;
    seriesName: string | null;
    carName: string | null;
    position: number;
    date: string;
  } | null;
  topTracks: RecapGroupStat[];
  topCars: RecapGroupStat[];
  topSeries: { name: string; races: number }[];
  byMonth: { month: number; races: number; podiums: number }[];
  drivers: RecapDriver[];
  awards: RecapAward[];
  firsts: {
    firstRace: { date: string; trackName: string } | null;
    lastRace: { date: string; trackName: string } | null;
  };
}

export interface RecapFilters {
  /** Null = "the current year, or the latest year with results if this one has none". */
  year: number | null;
  /** Any sign — iRacing reports team ids as negative numbers in some payloads; compared by absolute value. */
  teamId: number | null;
}

export const RECAP_TTL_MS = 5 * 60_000;
const RECAP_CACHE_MAX_ENTRIES = 100;
const TOP_LIST_SIZE = 5;
/** A driver needs this many laps before their incident rate is compared for the "cleanest" award. */
export const CLEANEST_MIN_LAPS = 200;

/** Same rule as the rest of the app: class position when present, else overall. Non-positive values count as none. */
function resultPosition(result: Pick<RaceResult, 'finishingPositionInClass' | 'finishingPosition'>): number | null {
  const position = result.finishingPositionInClass ?? result.finishingPosition;
  return position !== null && position !== undefined && Number.isFinite(position) && position > 0 ? position : null;
}

/** Port of members-portal/src/lib/driverStats.ts stintDriveMs(): average lap time x laps completed,
 * null when either input is missing or not positive. */
export function stintDriveMs(stint: Pick<RaceResultDriverStint, 'averageLapTimeMs' | 'lapsComplete'>): number | null {
  const avg = stint.averageLapTimeMs;
  const laps = stint.lapsComplete;
  if (avg === null || laps === null || avg === undefined || laps === undefined) return null;
  if (!Number.isFinite(avg) || !Number.isFinite(laps) || avg <= 0 || laps <= 0) return null;
  return avg * laps;
}

function trackDisplayName(result: Pick<RaceResult, 'trackName' | 'trackConfig'>): string {
  return result.trackConfig ? `${result.trackName} — ${result.trackConfig}` : result.trackName;
}

function formatHours(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatLapTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const secondsStr = (totalSeconds - minutes * 60).toFixed(3).padStart(6, '0');
  return minutes > 0 ? `${minutes}:${secondsStr}` : secondsStr;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface ResultRow {
  id: string;
  trackId: string | null;
  trackName: string;
  trackConfig: string | null;
  carId: string | null;
  carName: string | null;
  seriesName: string | null;
  startTime: Date | null;
  endTime: Date | null;
  finishingPosition: number | null;
  finishingPositionInClass: number | null;
  teamLapsComplete: number | null;
  teamIncidents: number | null;
}

interface StintRow {
  raceResultId: string;
  iracingCustId: number;
  driverProfileId: string | null;
  displayName: string;
  averageLapTimeMs: number | null;
  bestLapTimeMs: number | null;
  incidents: number | null;
  lapsComplete: number | null;
}

/** The single winner of a metric, or null when nobody has it / the top spot is shared. `higherWins`
 * picks max vs. min. `compare` is injectable so rates can be compared exactly (cross-multiplied). */
function uniqueWinner<T>(candidates: T[], compare: (a: T, b: T) => number): T | null {
  if (candidates.length < 2) return null;
  const sorted = [...candidates].sort(compare);
  return compare(sorted[0], sorted[1]) === 0 ? null : sorted[0];
}

/** Awards over the per-driver rows. Each needs at least two drivers with the metric (a comparison)
 * and a single clear winner; ties and thin data simply omit the award. */
export function computeAwards(
  drivers: (RecapDriver & { bestLapTrack: string | null })[],
  teamDriveMs: number,
): RecapAward[] {
  const awards: RecapAward[] = [];

  const iron = uniqueWinner(
    drivers.filter((d) => d.driveMs > 0),
    (a, b) => b.driveMs - a.driveMs,
  );
  if (iron) {
    const share = teamDriveMs > 0 ? Math.round((iron.driveMs / teamDriveMs) * 100) : null;
    awards.push({
      key: 'iron-driver',
      title: 'Iron driver',
      driverName: iron.name,
      value: formatHours(iron.driveMs),
      detail: share !== null ? `${share}% of the team's driving` : null,
    });
  }

  const leader = uniqueWinner(
    drivers.filter((d) => d.laps > 0),
    (a, b) => b.laps - a.laps,
  );
  if (leader) {
    awards.push({
      key: 'lap-leader',
      title: 'Lap leader',
      driverName: leader.name,
      value: `${leader.laps.toLocaleString('en-US')} laps`,
      detail: null,
    });
  }

  const fastest = uniqueWinner(
    drivers.filter((d) => d.bestLapMs !== null),
    (a, b) => (a.bestLapMs as number) - (b.bestLapMs as number),
  );
  if (fastest) {
    awards.push({
      key: 'fastest-lap',
      title: 'Fastest lap',
      driverName: fastest.name,
      value: formatLapTime(fastest.bestLapMs as number),
      detail: fastest.bestLapTrack,
    });
  }

  const cleanest = uniqueWinner(
    drivers.filter((d) => d.laps >= CLEANEST_MIN_LAPS),
    // incidents/laps ascending, compared exactly by cross-multiplication (no float ties/noise)
    (a, b) => a.incidents * b.laps - b.incidents * a.laps,
  );
  if (cleanest) {
    awards.push({
      key: 'cleanest',
      title: 'Cleanest driver',
      driverName: cleanest.name,
      value: `${round((cleanest.incidents / cleanest.laps) * 100, 1)} per 100 laps`,
      detail: `${pluralize(cleanest.incidents, 'incident')} in ${cleanest.laps.toLocaleString('en-US')} laps`,
    });
  }

  const stinty = uniqueWinner(
    drivers.filter((d) => d.stints > 0),
    (a, b) => b.stints - a.stints,
  );
  if (stinty) {
    awards.push({
      key: 'most-stints',
      title: 'Most stints',
      driverName: stinty.name,
      value: pluralize(stinty.stints, 'stint'),
      detail: null,
    });
  }

  return awards;
}

@Injectable()
export class RecapService {
  private readonly cache = new Map<string, { value: RecapStats; at: number }>();
  private readonly inFlight = new Map<string, Promise<RecapStats>>();

  constructor(
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository: Repository<RaceResult>,
    @InjectRepository(RaceResultDriverStint)
    private readonly stintsRepository: Repository<RaceResultDriverStint>,
    @InjectRepository(IracingTeam)
    private readonly teamsRepository: Repository<IracingTeam>,
  ) {}

  /** Team season recap, cached per (year, team) for RECAP_TTL_MS. Nothing invalidates it: a freshly
   * imported result shows up once the entry expires. */
  async getRecap(filters: RecapFilters): Promise<RecapStats> {
    const teamKey = filters.teamId === null ? 'all' : String(Math.abs(filters.teamId));
    const key = `${filters.year ?? 'auto'}|${teamKey}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < RECAP_TTL_MS) return cached.value;

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.compute(filters)
        .then((value) => {
          this.remember(key, value);
          return value;
        })
        .finally(() => {
          this.inFlight.delete(key);
        });
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private remember(key: string, value: RecapStats): void {
    const now = Date.now();
    if (this.cache.size >= RECAP_CACHE_MAX_ENTRIES) {
      for (const [existingKey, entry] of this.cache) {
        if (now - entry.at >= RECAP_TTL_MS) this.cache.delete(existingKey);
      }
      if (this.cache.size >= RECAP_CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
    }
    this.cache.delete(key);
    this.cache.set(key, { value, at: now });
  }

  private async compute(filters: RecapFilters): Promise<RecapStats> {
    const absTeamId = filters.teamId === null ? null : Math.abs(filters.teamId);

    // Query 1: every (year, team) pair that has results -> the year list and the teams that appear in results.
    const pairs = await this.raceResultsRepository
      .createQueryBuilder('r')
      .select(`EXTRACT(YEAR FROM "r"."start_time" AT TIME ZONE 'UTC')`, 'year')
      .addSelect('"r"."team_id"', 'teamId')
      .distinct(true)
      .getRawMany<{ year: string | number | null; teamId: string | number }>();
    const availableYears = Array.from(
      new Set(pairs.map((p) => (p.year === null ? NaN : Number(p.year))).filter((y) => Number.isInteger(y))),
    ).sort((a, b) => b - a);
    const resultTeamIds = new Set(pairs.map((p) => Math.abs(Number(p.teamId))));

    const currentYear = new Date().getUTCFullYear();
    const year =
      filters.year ?? (availableYears.includes(currentYear) ? currentYear : (availableYears[0] ?? currentYear));

    // Query 2: team names — active teams plus any that show up in results (matched by absolute id).
    const lookupIds = [...resultTeamIds, ...(absTeamId === null ? [] : [absTeamId])].flatMap((id) => [id, -id]);
    const teamRows = await this.teamsRepository.find({
      where: lookupIds.length > 0 ? [{ active: true }, { teamId: In(lookupIds) }] : [{ active: true }],
    });
    const teamNames = new Map<number, string>();
    for (const row of teamRows) {
      const id = Math.abs(row.teamId);
      if (row.active || resultTeamIds.has(id) || id === absTeamId) teamNames.set(id, row.teamName);
    }
    for (const id of resultTeamIds) if (!teamNames.has(id)) teamNames.set(id, `Team ${id}`);
    const teams = [...teamNames.entries()]
      .map(([teamId, teamName]) => ({ teamId, teamName }))
      .sort((a, b) => a.teamName.localeCompare(b.teamName));
    const teamName = absTeamId === null ? null : (teamNames.get(absTeamId) ?? `Team ${absTeamId}`);

    // Query 3: the results of the year (UTC, [Jan 1, next Jan 1)) and team.
    const results = (await this.raceResultsRepository.find({
      select: {
        id: true,
        trackId: true,
        trackName: true,
        trackConfig: true,
        carId: true,
        carName: true,
        seriesName: true,
        startTime: true,
        endTime: true,
        finishingPosition: true,
        finishingPositionInClass: true,
        teamLapsComplete: true,
        teamIncidents: true,
      },
      where: {
        startTime: And(
          MoreThanOrEqual(new Date(Date.UTC(year, 0, 1))),
          LessThan(new Date(Date.UTC(year + 1, 0, 1))),
        ),
        ...(absTeamId === null ? {} : { teamId: In([absTeamId, -absTeamId]) }),
      },
    })) as ResultRow[];

    // Query 4: all their driver stints in one go.
    const stints =
      results.length === 0
        ? []
        : ((await this.stintsRepository.find({
            select: {
              raceResultId: true,
              iracingCustId: true,
              driverProfileId: true,
              displayName: true,
              averageLapTimeMs: true,
              bestLapTimeMs: true,
              incidents: true,
              lapsComplete: true,
            },
            where: { raceResultId: In(results.map((r) => r.id)) },
          })) as StintRow[]);

    return this.aggregate({ year, teamId: absTeamId, teamName, availableYears, teams }, results, stints);
  }

  /** Pure aggregation of the already-filtered rows (exposed through getRecap only). */
  private aggregate(
    base: Pick<RecapStats, 'year' | 'teamId' | 'teamName' | 'availableYears' | 'teams'>,
    results: ResultRow[],
    stints: StintRow[],
  ): RecapStats {
    const stintsByResult = new Map<string, StintRow[]>();
    for (const stint of stints) {
      const list = stintsByResult.get(stint.raceResultId);
      if (list) list.push(stint);
      else stintsByResult.set(stint.raceResultId, [stint]);
    }
    const resultById = new Map(results.map((r) => [r.id, r]));

    let laps = 0;
    let driveMs = 0;
    let incidents = 0;
    let incidentRaces = 0;
    let wins = 0;
    let podiums = 0;
    let topTens = 0;
    let rankedRaces = 0;
    let positionSum = 0;
    let bestFinish: number | null = null;
    const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, races: 0, podiums: 0 }));
    const tracks = new Map<string, RecapGroupStat>();
    const cars = new Map<string, RecapGroupStat>();
    const series = new Map<string, number>();

    let longest: { result: ResultRow; laps: number; driveMs: number | null; durationMs: number | null } | null = null;
    let best: { result: ResultRow; position: number } | null = null;
    let first: ResultRow | null = null;
    let last: ResultRow | null = null;

    const addGroup = (map: Map<string, RecapGroupStat>, key: string, id: string | null, name: string, pos: number | null) => {
      const group = map.get(key) ?? { id, name, races: 0, bestFinish: null };
      group.races += 1;
      if (pos !== null) group.bestFinish = group.bestFinish === null ? pos : Math.min(group.bestFinish, pos);
      map.set(key, group);
    };

    for (const result of results) {
      const resultStints = stintsByResult.get(result.id) ?? [];
      const stintLaps = resultStints.reduce((sum, s) => sum + (s.lapsComplete !== null && s.lapsComplete > 0 ? s.lapsComplete : 0), 0);
      const resultLaps = result.teamLapsComplete !== null && result.teamLapsComplete > 0 ? result.teamLapsComplete : stintLaps;
      laps += resultLaps;

      let resultDriveMs = 0;
      let timed = false;
      for (const stint of resultStints) {
        const ms = stintDriveMs(stint);
        if (ms !== null) {
          resultDriveMs += ms;
          timed = true;
        }
      }
      driveMs += resultDriveMs;

      const stintIncidents = resultStints.filter((s) => s.incidents !== null && s.incidents >= 0);
      const resultIncidents =
        result.teamIncidents !== null && result.teamIncidents >= 0
          ? result.teamIncidents
          : stintIncidents.length > 0
            ? stintIncidents.reduce((sum, s) => sum + (s.incidents as number), 0)
            : null;
      if (resultIncidents !== null) {
        incidents += resultIncidents;
        incidentRaces += 1;
      }

      const position = resultPosition(result);
      if (position !== null) {
        rankedRaces += 1;
        positionSum += position;
        if (position === 1) wins += 1;
        if (position <= 3) podiums += 1;
        if (position <= 10) topTens += 1;
        bestFinish = bestFinish === null ? position : Math.min(bestFinish, position);
        if (best === null || position < best.position || (position === best.position && this.earlier(result, best.result))) {
          best = { result, position };
        }
      }

      if (result.startTime) {
        const bucket = byMonth[result.startTime.getUTCMonth()];
        bucket.races += 1;
        if (position !== null && position <= 3) bucket.podiums += 1;
        if (first === null || this.earlier(result, first)) first = result;
        if (last === null || this.earlier(last, result)) last = result;
      }

      const durationMs =
        result.startTime && result.endTime && result.endTime > result.startTime
          ? result.endTime.getTime() - result.startTime.getTime()
          : null;
      const candidate = { result, laps: resultLaps, driveMs: timed ? resultDriveMs : null, durationMs };
      if (longest === null || this.longerRace(candidate, longest)) longest = candidate;

      const trackName = trackDisplayName(result);
      addGroup(tracks, result.trackId ?? `name:${trackName.toLowerCase()}`, result.trackId, trackName, position);
      const carName = result.carName?.trim();
      if (carName) addGroup(cars, result.carId ?? `name:${carName.toLowerCase()}`, result.carId, carName, position);
      if (result.seriesName) series.set(result.seriesName, (series.get(result.seriesName) ?? 0) + 1);
    }

    const byRaces = (a: RecapGroupStat, b: RecapGroupStat) =>
      b.races - a.races ||
      (a.bestFinish ?? Infinity) - (b.bestFinish ?? Infinity) ||
      a.name.localeCompare(b.name);

    // Per driver (keyed by iRacing customer id — the stable identity across results).
    const driverMap = new Map<
      number,
      RecapDriver & { raceIds: Set<string>; bestLapTrack: string | null }
    >();
    for (const stint of stints) {
      const result = resultById.get(stint.raceResultId);
      const entry = driverMap.get(stint.iracingCustId) ?? {
        driverProfileId: stint.driverProfileId,
        name: stint.displayName,
        races: 0,
        laps: 0,
        driveMs: 0,
        bestLapMs: null,
        incidents: 0,
        stints: 0,
        raceIds: new Set<string>(),
        bestLapTrack: null,
      };
      entry.raceIds.add(stint.raceResultId);
      entry.stints += 1;
      if (stint.lapsComplete !== null && stint.lapsComplete > 0) entry.laps += stint.lapsComplete;
      entry.driveMs += stintDriveMs(stint) ?? 0;
      if (stint.incidents !== null && stint.incidents >= 0) entry.incidents += stint.incidents;
      if (stint.bestLapTimeMs !== null && stint.bestLapTimeMs > 0 && (entry.bestLapMs === null || stint.bestLapTimeMs < entry.bestLapMs)) {
        entry.bestLapMs = stint.bestLapTimeMs;
        entry.bestLapTrack = result ? trackDisplayName(result) : null;
      }
      entry.name = stint.displayName;
      entry.driverProfileId = stint.driverProfileId ?? entry.driverProfileId;
      driverMap.set(stint.iracingCustId, entry);
    }
    const driverRows = [...driverMap.values()]
      .map(({ raceIds, ...d }) => ({ ...d, races: raceIds.size }))
      .sort((a, b) => b.driveMs - a.driveMs || b.races - a.races || a.name.localeCompare(b.name));

    const drivers: RecapDriver[] = driverRows.map((d) => ({
      driverProfileId: d.driverProfileId,
      name: d.name,
      races: d.races,
      laps: d.laps,
      driveMs: d.driveMs,
      bestLapMs: d.bestLapMs,
      incidents: d.incidents,
      stints: d.stints,
    }));

    return {
      ...base,
      totals: {
        races: results.length,
        laps,
        driveMs,
        wins,
        podiums,
        topTens,
        incidents,
        avgFinish: rankedRaces > 0 ? round(positionSum / rankedRaces, 2) : null,
        bestFinish,
        avgIncidentsPerRace: incidentRaces > 0 ? round(incidents / incidentRaces, 2) : null,
      },
      longestRace: longest
        ? {
            resultId: longest.result.id,
            trackName: trackDisplayName(longest.result),
            seriesName: longest.result.seriesName,
            lapsComplete: longest.laps,
            driveMs: longest.driveMs,
            durationMs: longest.durationMs,
            date: (longest.result.startTime as Date).toISOString(),
          }
        : null,
      bestResult: best
        ? {
            resultId: best.result.id,
            trackName: trackDisplayName(best.result),
            seriesName: best.result.seriesName,
            carName: best.result.carName,
            position: best.position,
            date: (best.result.startTime as Date).toISOString(),
          }
        : null,
      topTracks: [...tracks.values()].sort(byRaces).slice(0, TOP_LIST_SIZE),
      topCars: [...cars.values()].sort(byRaces).slice(0, TOP_LIST_SIZE),
      topSeries: [...series.entries()]
        .map(([name, races]) => ({ name, races }))
        .sort((a, b) => b.races - a.races || a.name.localeCompare(b.name))
        .slice(0, TOP_LIST_SIZE),
      byMonth,
      drivers,
      awards: computeAwards(driverRows, driveMs),
      firsts: {
        firstRace: first ? { date: (first.startTime as Date).toISOString(), trackName: trackDisplayName(first) } : null,
        lastRace: last ? { date: (last.startTime as Date).toISOString(), trackName: trackDisplayName(last) } : null,
      },
    };
  }

  private earlier(a: ResultRow, b: ResultRow): boolean {
    return (a.startTime?.getTime() ?? Infinity) < (b.startTime?.getTime() ?? Infinity);
  }

  /** "Longest" = longest wall-clock race, then most driving time, then most laps; the earlier race wins an exact tie. */
  private longerRace(
    a: { result: ResultRow; laps: number; driveMs: number | null; durationMs: number | null },
    b: { result: ResultRow; laps: number; driveMs: number | null; durationMs: number | null },
  ): boolean {
    const keys = (x: typeof a) => [x.durationMs ?? 0, x.driveMs ?? 0, x.laps];
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
    return this.earlier(a.result, b.result);
  }
}
