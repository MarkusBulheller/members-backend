import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IracingCarUsageScannedSubsession } from './iracing-car-usage-scanned-subsession.entity.js';
import { IracingCarUsageStat } from './iracing-car-usage-stat.entity.js';
import { IracingSeriesSeason } from './iracing-series-season.entity.js';
import { IracingService } from './iracing.service.js';

// Every scan re-searches this whole trailing window rather than picking up where the last scan
// left off — no drift bookkeeping to get wrong, no gap a race can fall through. Re-searching
// ground already covered is cheap; the scanned-subsession dedup below is what makes it safe to
// repeat without double-counting.
const SCAN_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** Builds up a "most-used cars" tierlist per (series season, race week), one hourly scan at a
 * time — see IracingCarUsageSyncService for the cron that drives this. Kept separate from
 * IracingSeriesService (which owns the read-through catalog sync) since this is its own
 * incrementally-built dataset with real scan-window bookkeeping, not a wholesale refresh. */
@Injectable()
export class IracingCarUsageService {
  private readonly logger = new Logger(IracingCarUsageService.name);

  constructor(
    @InjectRepository(IracingSeriesSeason)
    private readonly seasonsRepository: Repository<IracingSeriesSeason>,
    @InjectRepository(IracingCarUsageStat)
    private readonly statsRepository: Repository<IracingCarUsageStat>,
    @InjectRepository(IracingCarUsageScannedSubsession)
    private readonly scannedRepository: Repository<IracingCarUsageScannedSubsession>,
    private readonly iracingService: IracingService,
  ) {}

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

    let countedCount = 0;
    for (const subsessionId of subsessionIds) {
      const alreadyScanned = await this.scannedRepository.findOne({ where: { subsessionId } });
      if (alreadyScanned) continue;

      try {
        const cars = await this.iracingService.fetchCarUsageForSubsession(accessToken, subsessionId);
        // An empty result means the RACE simsession isn't scored yet (the event has started but
        // the race itself is still running) — NOT that it never will be. Only mark it scanned once
        // we've actually pulled cars from it, so the next scan (still within the lookback window)
        // retries it instead of permanently skipping a race we just caught mid-session.
        if (cars.length === 0) continue;
        countedCount += 1;
        for (const car of cars) {
          await this.incrementCarUsage(season.seasonId, currentWeek, car.carId, car.carName, car.carClass);
        }
        await this.scannedRepository.save(this.scannedRepository.create({ subsessionId }));
      } catch (error) {
        // One bad subsession shouldn't sink the whole scan — log and keep going. Deliberately
        // NOT marked scanned, so the next scan (still within the lookback window) retries it.
        this.logger.warn(`Failed to fetch car usage for subsession ${subsessionId}: ${(error as Error).message}`);
      }
    }
    this.logger.log(
      `Season ${season.seasonId} (${season.seriesName}) week ${currentWeek}: ${countedCount} new result(s) since ${scanStart.toISOString()} (${subsessionIds.length} in range)`,
    );
  }

  private async incrementCarUsage(
    seasonId: number,
    raceWeekNum: number,
    carId: number,
    carName: string,
    carClass: string,
  ): Promise<void> {
    let stat = await this.statsRepository.findOne({ where: { seasonId, raceWeekNum, carId } });
    if (!stat) {
      stat = this.statsRepository.create({ seasonId, raceWeekNum, carId, carName, carClass, entryCount: 0 });
    }
    stat.carName = carName; // keep it fresh in case iRacing's own naming ever changes
    stat.carClass = carClass;
    stat.entryCount += 1;
    await this.statsRepository.save(stat);
  }

  /** schedule is the raw per-race-week array from /series/season_schedule (see
   * IracingSeriesService) — each entry carries its own start_date/week_end_time, confirmed
   * against the community iracingdataapi client's schema (not iRacing's own public docs). */
  private findCurrentRaceWeek(season: IracingSeriesSeason, now: Date): number | null {
    for (const entry of season.schedule) {
      const week = entry as Record<string, unknown>;
      const raceWeekNum = typeof week.race_week_num === 'number' ? week.race_week_num : null;
      const startDate = typeof week.start_date === 'string' ? new Date(week.start_date) : null;
      const weekEnd = typeof week.week_end_time === 'string' ? new Date(week.week_end_time) : null;
      if (
        raceWeekNum !== null &&
        startDate !== null &&
        weekEnd !== null &&
        !Number.isNaN(startDate.getTime()) &&
        !Number.isNaN(weekEnd.getTime()) &&
        now >= startDate &&
        now < weekEnd
      ) {
        return raceWeekNum;
      }
    }
    return null;
  }
}
