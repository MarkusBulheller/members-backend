import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, QueryFailedError, Repository } from 'typeorm';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { IracingCarUsageScannedSubsession } from './iracing-car-usage-scanned-subsession.entity.js';
import { IracingCarUsageStat } from './iracing-car-usage-stat.entity.js';
import { IracingSeriesSeason } from './iracing-series-season.entity.js';
import { IracingService } from './iracing.service.js';

// Every scan re-searches this whole trailing window rather than picking up where the last scan
// left off — no drift bookkeeping to get wrong, no gap a race can fall through. Re-searching
// ground already covered is cheap; the scanned-subsession dedup below is what makes it safe to
// repeat without double-counting.
const SCAN_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';
/** Keeps the "already scanned?" IN (...) lookup well under Postgres' bind-parameter limit. */
const SCANNED_LOOKUP_CHUNK = 1000;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION
  );
}

/** Builds up a "most-used cars" tierlist per (series season, race week), one hourly scan at a
 * time — see IracingCarUsageSyncService for the cron that drives this. Kept separate from
 * IracingSeriesService (which owns the read-through catalog sync) since this is its own
 * incrementally-built dataset with real scan-window bookkeeping, not a wholesale refresh. */
@Injectable()
export class IracingCarUsageService {
  private readonly logger = new Logger(IracingCarUsageService.name);
  /** True while a scan (the hourly cron or an admin's on-demand backfill) is running in this
   * process; the scheduler would otherwise start the next hourly run on top of a slow one. */
  private scanning = false;

  constructor(
    @InjectRepository(IracingSeriesSeason)
    private readonly seasonsRepository: Repository<IracingSeriesSeason>,
    @InjectRepository(IracingCarUsageStat)
    private readonly statsRepository: Repository<IracingCarUsageStat>,
    @InjectRepository(IracingCarUsageScannedSubsession)
    private readonly scannedRepository: Repository<IracingCarUsageScannedSubsession>,
    private readonly iracingService: IracingService,
    private readonly adminTokenService: IracingAdminTokenService,
  ) {}

  /** Runs `task` unless another scan is already in progress, in which case it resolves to
   * `{ ran: false }` without calling it. Shared by the hourly cron and scanSince so the two can't
   * overlap (double-spending a single-use iRacing refresh token, hammering the Data API). */
  async runExclusive<T>(task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.scanning) return { ran: false };
    this.scanning = true;
    try {
      return { ran: true, value: await task() };
    } finally {
      this.scanning = false;
    }
  }

  listTrackedSeasons(): Promise<IracingSeriesSeason[]> {
    return this.seasonsRepository.find({ where: { trackCarUsage: true }, order: { seriesName: 'ASC' } });
  }

  async setTracked(seasonId: number, tracked: boolean): Promise<IracingSeriesSeason> {
    const season = await this.seasonsRepository.findOne({ where: { seasonId } });
    if (!season) {
      throw new NotFoundException('Series season not found');
    }
    season.trackCarUsage = tracked;
    return this.seasonsRepository.save(season);
  }

  getTierlist(seasonId: number, raceWeekNum: number): Promise<IracingCarUsageStat[]> {
    return this.statsRepository.find({
      where: { seasonId, raceWeekNum },
      order: { entryCount: 'DESC', carName: 'ASC' },
    });
  }

  /** How many race entries the scans have tallied so far for one race week (the sum behind the
   * tierlist's percentages) and how many distinct cars they spread over. Zeroes when nothing has
   * been scanned yet. */
  async getEntriesScanned(
    seasonId: number,
    raceWeekNum: number,
  ): Promise<{ seasonId: number; raceWeekNum: number; entriesScanned: number; carCount: number }> {
    const row = await this.statsRepository
      .createQueryBuilder('s')
      .select('COALESCE(SUM(s.entryCount), 0)', 'entries')
      .addSelect('COUNT(*)', 'cars')
      .where('s.seasonId = :seasonId', { seasonId })
      .andWhere('s.raceWeekNum = :raceWeekNum', { raceWeekNum })
      .getRawOne<{ entries: string; cars: string }>();
    return {
      seasonId,
      raceWeekNum,
      entriesScanned: Number(row?.entries ?? 0),
      carCount: Number(row?.cars ?? 0),
    };
  }

  /** One tracked season's worth of the hourly scan: find whichever race week is current right
   * now, pull every official race in the last SCAN_LOOKBACK_MS, and tally the car each entry used
   * — skipping any subsession already recorded in a previous scan. Silently returns (no-ops) when
   * the season isn't between two race weeks' start/end right now — an off-season or a schedule
   * gap, both a "nothing to scan yet" state rather than an error. */
  async scanSeason(season: IracingSeriesSeason, accessToken: string): Promise<void> {
    const now = new Date();
    const currentWeek = this.findCurrentRaceWeek(season, now);
    if (currentWeek === null) {
      this.logger.log(`Season ${season.seasonId} (${season.seriesName}): no race week is currently live — skipping`);
      return;
    }

    const scanStart = new Date(now.getTime() - SCAN_LOOKBACK_MS);
    const subsessionIds = await this.iracingService.searchSeriesResults(
      accessToken,
      season.seriesId,
      currentWeek,
      scanStart,
      now,
    );

    const countedCount = await this.scanSubsessions(season.seasonId, currentWeek, subsessionIds, accessToken);
    this.logger.log(
      `Season ${season.seasonId} (${season.seriesName}) week ${currentWeek}: ${countedCount} new result(s) since ${scanStart.toISOString()} (${subsessionIds.length} in range)`,
    );
  }

  /** On-demand backfill for an admin who wants results older than the hourly scan's lookback
   * window — e.g. right after switching trackCarUsage on mid-season, or catching up a week the
   * live scan missed. Unlike scanSeason (always just the currently-live week), this walks every
   * race week whose window falls at or after `since`, using [since, now] as the search range for
   * each — the API still scopes by race_week_num, so a broad range here just means "anything in
   * this particular week that happened after `since`," not a cross-week search. */
  async scanSince(seasonId: number, since: Date, adminUserId: string): Promise<void> {
    if (Number.isNaN(since.getTime())) {
      throw new BadRequestException('Invalid "since" date');
    }
    const outcome = await this.runExclusive(() => this.scanSinceUnguarded(seasonId, since, adminUserId));
    if (!outcome.ran) {
      throw new ConflictException('A car usage scan is already running, try again in a few minutes.');
    }
  }

  private async scanSinceUnguarded(seasonId: number, since: Date, adminUserId: string): Promise<void> {
    const season = await this.seasonsRepository.findOne({ where: { seasonId } });
    if (!season) {
      throw new NotFoundException('Series season not found');
    }

    const now = new Date();
    const weeks = this.raceWeeksInRange(season, since, now);
    if (weeks.length === 0) {
      this.logger.log(`Season ${season.seasonId} (${season.seriesName}): no race weeks fall on or after ${since.toISOString()}`);
      return;
    }

    const accessToken = await this.adminTokenService.getAccessToken(adminUserId);
    for (const raceWeekNum of weeks) {
      const subsessionIds = await this.iracingService.searchSeriesResults(
        accessToken,
        season.seriesId,
        raceWeekNum,
        since,
        now,
      );
      const countedCount = await this.scanSubsessions(season.seasonId, raceWeekNum, subsessionIds, accessToken);
      this.logger.log(
        `Season ${season.seasonId} (${season.seriesName}) week ${raceWeekNum}: ${countedCount} new result(s) since ${since.toISOString()} (${subsessionIds.length} in range)`,
      );
    }
  }

  /** Shared by scanSeason and scanSince — tallies every not-yet-seen subsession in the given list
   * against (seasonId, raceWeekNum), same dedup/skip/error-handling rules either way. */
  private async scanSubsessions(
    seasonId: number,
    raceWeekNum: number,
    subsessionIds: number[],
    accessToken: string,
  ): Promise<number> {
    // One lookup for the whole batch instead of a findOne per subsession.
    const alreadyScanned = await this.loadScannedSubsessionIds(subsessionIds);

    let countedCount = 0;
    for (const subsessionId of subsessionIds) {
      if (alreadyScanned.has(subsessionId)) continue;

      try {
        const cars = await this.iracingService.fetchCarUsageForSubsession(accessToken, subsessionId);
        // An empty result means the RACE simsession isn't scored yet (the event has started but
        // the race itself is still running) — NOT that it never will be. Only mark it scanned once
        // we've actually pulled cars from it, so the next scan (still within the lookback window)
        // retries it instead of permanently skipping a race we just caught mid-session.
        if (cars.length === 0) continue;
        if (await this.recordSubsession(seasonId, raceWeekNum, subsessionId, cars)) {
          countedCount += 1;
        }
      } catch (error) {
        // One bad subsession shouldn't sink the whole scan — log and keep going. Deliberately
        // NOT marked scanned (the transaction rolled back), so a later scan covering this range
        // retries it.
        this.logger.warn(`Failed to fetch car usage for subsession ${subsessionId}: ${(error as Error).message}`);
      }
    }
    return countedCount;
  }

  private async loadScannedSubsessionIds(subsessionIds: number[]): Promise<Set<number>> {
    const scanned = new Set<number>();
    for (let i = 0; i < subsessionIds.length; i += SCANNED_LOOKUP_CHUNK) {
      const chunk = subsessionIds.slice(i, i + SCANNED_LOOKUP_CHUNK);
      const rows = await this.scannedRepository.find({ where: { subsessionId: In(chunk) } });
      for (const row of rows) scanned.add(row.subsessionId);
    }
    return scanned;
  }

  /** Marks the subsession scanned AND adds its cars to the tally in one transaction. The scanned
   * row goes in first: its unique index arbitrates between two scans racing for the same
   * subsession (the loser gets a unique violation, rolls back, and counts nothing), and the
   * counter bump is a single atomic `entry_count = entry_count + n` upsert rather than a
   * read-modify-write. Returns false when another scan already recorded it. */
  private async recordSubsession(
    seasonId: number,
    raceWeekNum: number,
    subsessionId: number,
    cars: { carId: number; carName: string; carClass: string }[],
  ): Promise<boolean> {
    // Several entries can share a car (and a multi-row upsert can't touch the same conflict
    // target twice), so fold them into one row per car first.
    const byCar = new Map<number, { carId: number; carName: string; carClass: string; count: number }>();
    for (const car of cars) {
      const existing = byCar.get(car.carId);
      if (existing) {
        existing.count += 1;
        existing.carName = car.carName;
        existing.carClass = car.carClass;
      } else {
        byCar.set(car.carId, { carId: car.carId, carName: car.carName, carClass: car.carClass, count: 1 });
      }
    }
    const rows = Array.from(byCar.values());
    const placeholders = rows
      .map((_, i) => {
        const o = i * 7;
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`;
      })
      .join(', ');
    const params = rows.flatMap((row) => [
      randomUUID(),
      seasonId,
      raceWeekNum,
      row.carId,
      row.carName, // refreshed on conflict too, in case iRacing's own naming ever changes
      row.carClass,
      row.count,
    ]);

    try {
      await this.statsRepository.manager.transaction(async (manager) => {
        await manager.insert(IracingCarUsageScannedSubsession, { subsessionId });
        await manager.query(
          `INSERT INTO iracing_car_usage_stats (id, season_id, race_week_num, car_id, car_name, car_class, entry_count)
           VALUES ${placeholders}
           ON CONFLICT (season_id, race_week_num, car_id) DO UPDATE SET
             car_name = EXCLUDED.car_name,
             car_class = EXCLUDED.car_class,
             entry_count = iracing_car_usage_stats.entry_count + EXCLUDED.entry_count,
             updated_at = now()`,
          params,
        );
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // someone else counted this subsession first
      throw error;
    }
  }

  /** schedule is the raw per-race-week array from /series/season_schedule (see
   * IracingSeriesService) — each entry carries its own start_date/week_end_time, confirmed
   * against the community iracingdataapi client's schema (not iRacing's own public docs). */
  private parseScheduleEntry(entry: unknown): { raceWeekNum: number; startDate: Date; weekEnd: Date } | null {
    const week = entry as Record<string, unknown>;
    const raceWeekNum = typeof week.race_week_num === 'number' ? week.race_week_num : null;
    const startDate = typeof week.start_date === 'string' ? new Date(week.start_date) : null;
    const weekEnd = typeof week.week_end_time === 'string' ? new Date(week.week_end_time) : null;
    if (
      raceWeekNum === null ||
      startDate === null ||
      weekEnd === null ||
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(weekEnd.getTime())
    ) {
      return null;
    }
    return { raceWeekNum, startDate, weekEnd };
  }

  private findCurrentRaceWeek(season: IracingSeriesSeason, now: Date): number | null {
    for (const entry of season.schedule) {
      const week = this.parseScheduleEntry(entry);
      if (week && now >= week.startDate && now < week.weekEnd) {
        return week.raceWeekNum;
      }
    }
    return null;
  }

  /** Every race week that's actually started by `now` and hadn't already ended before `since` —
   * i.e. every week scanSince should bother searching. */
  private raceWeeksInRange(season: IracingSeriesSeason, since: Date, now: Date): number[] {
    const weeks: number[] = [];
    for (const entry of season.schedule) {
      const week = this.parseScheduleEntry(entry);
      if (week && week.startDate <= now && week.weekEnd >= since) {
        weeks.push(week.raceWeekNum);
      }
    }
    return weeks;
  }
}
