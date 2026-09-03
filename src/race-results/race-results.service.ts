import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { CarsService } from '../cars/cars.service.js';
import { DriversService } from '../drivers/drivers.service.js';
import { IracingCarsService } from '../iracing/iracing-cars.service.js';
import { IracingRaceResultLookupService } from '../iracing/iracing-race-result-lookup.service.js';
import { IracingTracksService } from '../iracing/iracing-tracks.service.js';
import { IracingRaceResultDriverData } from '../iracing/iracing.service.js';
import { TracksService } from '../tracks/tracks.service.js';
import { RaceResultDriverStint } from './race-result-driver-stint.entity.js';
import { RaceResultLap } from './race-result-lap.entity.js';
import { RaceResult } from './race-result.entity.js';

@Injectable()
export class RaceResultsService {
  constructor(
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository: Repository<RaceResult>,
    @InjectRepository(RaceResultDriverStint)
    private readonly stintsRepository: Repository<RaceResultDriverStint>,
    @InjectRepository(RaceResultLap)
    private readonly lapsRepository: Repository<RaceResultLap>,
    private readonly lookupService: IracingRaceResultLookupService,
    private readonly driversService: DriversService,
    private readonly carsService: CarsService,
    private readonly tracksService: TracksService,
    private readonly iracingCarsService: IracingCarsService,
    private readonly iracingTracksService: IracingTracksService,
  ) {}

  /** Only what the anonymous public marketing site's "Recent Results" table needs — no driver
   * names, no per-lap detail, just enough to show real finishes. See PublicRaceResultsController.
   * Position prefers in-class the same way every other position display in this app does. */
  async findPublicRecent(limit: number): Promise<
    { id: string; trackName: string; trackConfig: string | null; seriesName: string | null; carName: string | null; finish: string | null }[]
  > {
    const results = await this.raceResultsRepository.find({
      // Excludes anything without a start time rather than relying on Postgres's NULLS FIRST
      // default for DESC — a null would otherwise outrank every real, dated result.
      where: { startTime: Not(IsNull()) },
      order: { startTime: 'DESC' },
      take: limit,
    });
    return results.map((result) => {
      const position = result.finishingPositionInClass ?? result.finishingPosition;
      return {
        id: result.id,
        trackName: result.trackName,
        trackConfig: result.trackConfig,
        seriesName: result.seriesName,
        carName: result.carName,
        finish: position !== null ? `P${position}` : null,
      };
    });
  }

  list(): Promise<RaceResult[]> {
    return this.raceResultsRepository.find({
      relations: { driverStints: true },
      order: { startTime: 'DESC' },
    });
  }

  /** Every result a given driver has a stint in — used by DriverDetailPage's "Races" section.
   * Joins driverStints twice: once (unselected) just to filter which results qualify, once
   * (selected) to bring back that result's full stint list. */
  findByDriverProfileId(driverProfileId: string): Promise<RaceResult[]> {
    return this.raceResultsRepository
      .createQueryBuilder('result')
      .innerJoin('result.driverStints', 'ownStint', 'ownStint.driverProfileId = :driverProfileId', {
        driverProfileId,
      })
      .leftJoinAndSelect('result.driverStints', 'allStints')
      .orderBy('result.startTime', 'DESC')
      .getMany();
  }

  /** Every result for a given roster Car — used by CarDetailPage's "Races" section. Direct FK
   * filter, unlike findByDriverProfileId's join, since carId lives on the result itself. */
  findByCarId(carId: string): Promise<RaceResult[]> {
    return this.raceResultsRepository.find({
      where: { carId },
      relations: { driverStints: true },
      order: { startTime: 'DESC' },
    });
  }

  /** Every result at a given roster Track — used by TrackDetailPage's "Races" section. */
  findByTrackId(trackId: string): Promise<RaceResult[]> {
    return this.raceResultsRepository.find({
      where: { trackId },
      relations: { driverStints: true },
      order: { startTime: 'DESC' },
    });
  }

  async findByIdOrThrow(id: string): Promise<RaceResult> {
    const result = await this.raceResultsRepository.findOne({
      where: { id },
      relations: { driverStints: true, laps: true },
    });
    if (!result) {
      throw new NotFoundException('Race result not found');
    }
    return result;
  }

  async importFromIracing(adminUserId: string, subsessionId: number, teamId: number): Promise<RaceResult> {
    const existing = await this.raceResultsRepository.findOne({ where: { subsessionId, teamId } });
    if (existing) {
      throw new ConflictException('This result has already been added.');
    }

    const data = await this.lookupService.lookupAsAdmin(adminUserId, subsessionId, teamId);

    // Link (and auto-create if missing) our roster's Car/Track, so results show up on those
    // pages too — see CarsService.ensureExists()/TracksService.ensureExists(). Track name is
    // composed the same way TrackFormPage's "Pick from iRacing" flow does, so an already-added
    // track is matched instead of duplicated. Where possible, look the car/track up in our local
    // iRacing catalog by its numeric id (real image/category/location data — see
    // IracingCarsService/IracingTracksService.findByIdWithImages()) rather than leaving an
    // auto-created stub with no picture, same as an admin would get from the "Pick from iRacing"
    // form.
    const catalogCar = data.carId !== null ? await this.iracingCarsService.findByIdWithImages(data.carId) : null;
    const car = data.carName
      ? await this.carsService.ensureExists(data.carName, {
          imageUrl: catalogCar?.smallImageUrl ?? null,
          carClass: normalizeCarClassName(data.carClassName),
        })
      : null;

    const catalogTrack =
      data.trackId !== null ? await this.iracingTracksService.findByIdWithImages(data.trackId) : null;
    const trackName = data.trackConfig ? `${data.trackName} - ${data.trackConfig}` : data.trackName;
    const track = await this.tracksService.ensureExists(trackName, {
      category: catalogTrack?.category ?? null,
      location: catalogTrack?.location ?? null,
      imageUrl: catalogTrack?.logoUrl ?? null,
    });

    const raceResult = this.raceResultsRepository.create({
      subsessionId: data.subsessionId,
      teamId: data.teamId,
      seriesName: data.seriesName,
      trackName: data.trackName,
      trackConfig: data.trackConfig,
      carName: data.carName,
      carId: car?.id ?? null,
      trackId: track.id,
      startTime: data.startTime ? new Date(data.startTime) : null,
      endTime: data.endTime ? new Date(data.endTime) : null,
      startingPosition: data.startingPosition,
      finishingPosition: data.finishingPosition,
      startingPositionInClass: data.startingPositionInClass,
      finishingPositionInClass: data.finishingPositionInClass,
      teamLapsComplete: data.teamLapsComplete,
      totalLaps: data.totalLaps,
      teamIncidents: data.teamIncidents,
      splitNumber: data.splitNumber,
      totalSplits: data.totalSplits,
    });
    const saved = await this.raceResultsRepository.save(raceResult);

    // Every participating driver not already on our roster gets a manual profile auto-created
    // from their race-result snapshot, so results and driver pages both link up immediately.
    const driverProfileIdByCustId = new Map<number, string | null>();
    for (const driver of data.drivers) {
      const profile = await this.driversService.ensureManualDriverExists({
        custId: driver.custId,
        name: driver.displayName,
        location: driver.location,
        countryCode: driver.countryCode,
        sportsCarIrating: driver.sportsCarIrating,
        sportsCarSafetyRating: driver.sportsCarSafetyRating,
        refreshToken: null,
      });
      driverProfileIdByCustId.set(driver.custId, profile.id);
    }

    const stints = data.drivers.map((driver: IracingRaceResultDriverData) =>
      this.stintsRepository.create({
        raceResultId: saved.id,
        driverProfileId: driverProfileIdByCustId.get(driver.custId) ?? null,
        iracingCustId: driver.custId,
        displayName: driver.displayName,
        startingPosition: driver.startingPosition,
        finishingPosition: driver.finishingPosition,
        averageLapTimeMs: driver.averageLapTimeMs,
        bestLapTimeMs: driver.bestLapTimeMs,
        incidents: driver.incidents,
        lapsComplete: driver.lapsComplete,
      }),
    );
    await this.stintsRepository.save(stints);

    if (data.laps.length > 0) {
      const laps = data.laps.map((lap) =>
        this.lapsRepository.create({
          raceResultId: saved.id,
          driverProfileId: driverProfileIdByCustId.get(lap.custId) ?? null,
          iracingCustId: lap.custId,
          displayName: lap.displayName,
          lapNumber: lap.lapNumber,
          lapTimeMs: lap.lapTimeMs,
          incident: lap.incident,
          sessionTime: lap.sessionTime,
        }),
      );
      await this.lapsRepository.save(laps);
    }

    return this.findByIdOrThrow(saved.id);
  }

  async remove(id: string): Promise<void> {
    const result = await this.raceResultsRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Race result not found');
    }
  }

  /** Public, unauthenticated lookup by share token — see PublicRaceResultsController. Only
   * reachable at all if an admin has explicitly generated a link via generateShareLink(); every
   * other result stays login-gated. */
  async findByShareTokenOrThrow(shareToken: string): Promise<RaceResult> {
    const result = await this.raceResultsRepository.findOne({
      where: { shareToken },
      relations: { driverStints: true, laps: true },
    });
    if (!result) {
      throw new NotFoundException('Shared result not found');
    }
    return result;
  }

  /** Idempotent: returns the existing token if this result is already shared, otherwise mints a
   * new one. A distinct random token (not the result's own id) so the link can be revoked without
   * touching the result's normal id, and so it can't be derived from anything else the row
   * exposes. */
  async generateShareLink(id: string): Promise<{ shareToken: string }> {
    const result = await this.raceResultsRepository.findOne({ where: { id } });
    if (!result) {
      throw new NotFoundException('Race result not found');
    }
    if (result.shareToken) {
      return { shareToken: result.shareToken };
    }
    result.shareToken = randomUUID();
    await this.raceResultsRepository.save(result);
    return { shareToken: result.shareToken };
  }

  async revokeShareLink(id: string): Promise<void> {
    const result = await this.raceResultsRepository.findOne({ where: { id } });
    if (!result) {
      throw new NotFoundException('Race result not found');
    }
    result.shareToken = null;
    await this.raceResultsRepository.save(result);
  }
}

/** iRacing's car_class_name comes back like "GT3 Class" — strips the redundant " Class" suffix
 * so an auto-created Car's class lines up with how the team names classes elsewhere (e.g. the
 * "GT3" option in CarFormPage's picker), without assuming every class name follows the pattern. */
function normalizeCarClassName(carClassName: string | null): string | null {
  if (!carClassName) return null;
  return carClassName.replace(/\s+class$/i, '').trim() || carClassName;
}
