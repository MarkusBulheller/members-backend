import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RaceResult } from '../race-results/race-result.entity.js';

export interface DashboardFilters {
  year: number | null;
  trackId: string | null;
  carId: string | null;
  series: string | null;
  raceLength: string | null;
}

export interface DriverStat {
  iracingCustId: number;
  driverProfileId: string | null;
  name: string;
  value: number;
}

export interface EntityStat {
  id: string | null;
  name: string;
  count: number;
}

export interface ResultPoint {
  id: string;
  date: string | null;
  position: number | null;
  trackName: string;
  carName: string | null;
}

export interface DashboardStats {
  mostEvents: DriverStat[];
  mostLaps: DriverStat[];
  leastIncidentsPerLap: DriverStat[];
  mostDrivenTracks: EntityStat[];
  mostDrivenCars: EntityStat[];
  results: ResultPoint[];
  filterOptions: {
    years: number[];
    tracks: { id: string | null; name: string }[];
    cars: { id: string | null; name: string }[];
    series: string[];
    raceLengths: string[];
  };
}

/** Team-wide totals only — no driver names, no per-entry detail — safe for the anonymous public
 * marketing site (see PublicStatsController) to show real numbers instead of hardcoded ones. */
export interface PublicSummaryStats {
  raceWins: number;
  podiumFinishes: number;
  hoursRaced: number;
  racesEntered: number;
}

/** A driver needs at least this many laps in the filtered window before they're eligible for
 * the "least incidents / lap" leaderboard — otherwise a driver with e.g. 2 clean laps would
 * outrank someone with 500 mostly-clean laps, which isn't a meaningful comparison. */
const MIN_LAPS_FOR_INCIDENT_RATE = 20;
const LEADERBOARD_SIZE = 10;

// Mirrors members-portal/src/lib/lapTime.ts's guessRaceLength() — kept as a small duplicated
// pure function rather than a shared package, since these are two separate npm projects.
const STANDARD_RACE_LENGTHS_MIN = [160, 180, 240, 360, 480, 600, 720, 1440];

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function raceLengthLabel(result: RaceResult): string | null {
  if (!result.startTime || !result.endTime) return null;
  const ms = result.endTime.getTime() - result.startTime.getTime();
  if (ms < 0) return null;
  const minutes = ms / 60000;
  const closest = STANDARD_RACE_LENGTHS_MIN.reduce((best, candidate) =>
    Math.abs(candidate - minutes) < Math.abs(best - minutes) ? candidate : best,
  );
  return formatDuration(closest * 60000);
}

function resultPosition(result: RaceResult): number | null {
  return result.finishingPositionInClass ?? result.finishingPosition;
}

function trackDisplayName(result: RaceResult): string {
  return result.trackConfig ? `${result.trackName} — ${result.trackConfig}` : result.trackName;
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository: Repository<RaceResult>,
  ) {}

  /** Real, team-wide totals for the public marketing site — every imported result counts once,
   * regardless of who drove. Position/class-position already fall back the same way
   * resultPosition() does everywhere else in this file. */
  async getPublicSummary(): Promise<PublicSummaryStats> {
    const results = await this.raceResultsRepository.find();
    let raceWins = 0;
    let podiumFinishes = 0;
    let hoursRacedMs = 0;
    for (const result of results) {
      const position = resultPosition(result);
      if (position === 1) raceWins += 1;
      if (position !== null && position <= 3) podiumFinishes += 1;
      if (result.startTime && result.endTime) {
        const ms = result.endTime.getTime() - result.startTime.getTime();
        if (ms > 0) hoursRacedMs += ms;
      }
    }
    return {
      raceWins,
      podiumFinishes,
      hoursRaced: Math.round(hoursRacedMs / 3_600_000),
      racesEntered: results.length,
    };
  }

  async getDashboard(filters: DashboardFilters): Promise<DashboardStats> {
    const allResults = await this.raceResultsRepository.find({ relations: { driverStints: true } });

    const filtered = allResults.filter((result) => {
      if (filters.year !== null && result.startTime?.getFullYear() !== filters.year) return false;
      if (filters.trackId !== null && result.trackId !== filters.trackId) return false;
      if (filters.carId !== null && result.carId !== filters.carId) return false;
      if (filters.series !== null && result.seriesName !== filters.series) return false;
      if (filters.raceLength !== null && raceLengthLabel(result) !== filters.raceLength) return false;
      return true;
    });

    const byDriver = new Map<
      number,
      { driverProfileId: string | null; name: string; events: Set<string>; laps: number; incidents: number }
    >();
    for (const result of filtered) {
      for (const stint of result.driverStints) {
        const entry = byDriver.get(stint.iracingCustId) ?? {
          driverProfileId: stint.driverProfileId,
          name: stint.displayName,
          events: new Set<string>(),
          laps: 0,
          incidents: 0,
        };
        entry.events.add(result.id);
        entry.laps += stint.lapsComplete ?? 0;
        entry.incidents += stint.incidents ?? 0;
        entry.name = stint.displayName;
        entry.driverProfileId = stint.driverProfileId ?? entry.driverProfileId;
        byDriver.set(stint.iracingCustId, entry);
      }
    }
    const drivers = Array.from(byDriver.entries()).map(([iracingCustId, d]) => ({ iracingCustId, ...d }));

    const mostEvents = [...drivers]
      .sort((a, b) => b.events.size - a.events.size)
      .slice(0, LEADERBOARD_SIZE)
      .map((d) => ({
        iracingCustId: d.iracingCustId,
        driverProfileId: d.driverProfileId,
        name: d.name,
        value: d.events.size,
      }));

    const mostLaps = [...drivers]
      .sort((a, b) => b.laps - a.laps)
      .slice(0, LEADERBOARD_SIZE)
      .map((d) => ({ iracingCustId: d.iracingCustId, driverProfileId: d.driverProfileId, name: d.name, value: d.laps }));

    const leastIncidentsPerLap = drivers
      .filter((d) => d.laps >= MIN_LAPS_FOR_INCIDENT_RATE)
      .sort((a, b) => a.incidents / a.laps - b.incidents / b.laps)
      .slice(0, LEADERBOARD_SIZE)
      .map((d) => ({
        iracingCustId: d.iracingCustId,
        driverProfileId: d.driverProfileId,
        name: d.name,
        value: Math.round((d.incidents / d.laps) * 1000) / 1000,
      }));

    const byTrack = new Map<string, EntityStat>();
    for (const result of filtered) {
      const key = result.trackId ?? `name:${result.trackName}|${result.trackConfig ?? ''}`;
      const entry = byTrack.get(key) ?? { id: result.trackId, name: trackDisplayName(result), count: 0 };
      entry.count += 1;
      byTrack.set(key, entry);
    }
    const mostDrivenTracks = Array.from(byTrack.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, LEADERBOARD_SIZE);

    const byCar = new Map<string, EntityStat>();
    for (const result of filtered) {
      if (!result.carName) continue;
      const key = result.carId ?? `name:${result.carName}`;
      const entry = byCar.get(key) ?? { id: result.carId, name: result.carName, count: 0 };
      entry.count += 1;
      byCar.set(key, entry);
    }
    const mostDrivenCars = Array.from(byCar.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, LEADERBOARD_SIZE);

    const results = filtered
      .map((result) => ({
        id: result.id,
        date: result.startTime?.toISOString() ?? null,
        position: resultPosition(result),
        trackName: trackDisplayName(result),
        carName: result.carName,
      }))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    const years = Array.from(
      new Set(allResults.map((r) => r.startTime?.getFullYear()).filter((y): y is number => y !== undefined)),
    ).sort((a, b) => b - a);
    const trackOptions = new Map<string, { id: string | null; name: string }>();
    const carOptions = new Map<string, { id: string | null; name: string }>();
    for (const result of allResults) {
      const trackKey = result.trackId ?? `name:${result.trackName}|${result.trackConfig ?? ''}`;
      trackOptions.set(trackKey, { id: result.trackId, name: trackDisplayName(result) });
      if (result.carName) {
        const carKey = result.carId ?? `name:${result.carName}`;
        carOptions.set(carKey, { id: result.carId, name: result.carName });
      }
    }
    const series = Array.from(new Set(allResults.map((r) => r.seriesName).filter((s): s is string => s !== null))).sort();
    const raceLengths = STANDARD_RACE_LENGTHS_MIN.map((min) => formatDuration(min * 60000)).filter((label) =>
      allResults.some((r) => raceLengthLabel(r) === label),
    );

    return {
      mostEvents,
      mostLaps,
      leastIncidentsPerLap,
      mostDrivenTracks,
      mostDrivenCars,
      results,
      filterOptions: {
        years,
        tracks: Array.from(trackOptions.values()).sort((a, b) => a.name.localeCompare(b.name)),
        cars: Array.from(carOptions.values()).sort((a, b) => a.name.localeCompare(b.name)),
        series,
        raceLengths,
      },
    };
  }
}
