import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { RaceResult } from '../race-results/race-result.entity.js';
import { User } from '../users/user.entity.js';
import { CarTrackSetup } from '../car-track-setups/car-track-setup.entity.js';
import { Livery } from '../liveries/livery.entity.js';
import { Car } from './car.entity.js';
import { CreateCarDto } from './dto/create-car.dto.js';
import { UpdateCarDto } from './dto/update-car.dto.js';
import { CARS_UPLOAD_DIR, CARS_UPLOAD_URL_PREFIX } from './multer.config.js';

/** A Car as returned by the list/detail endpoints: the entity plus how many imported race
 * results reference it (additive — older clients simply ignore the field). */
export type CarWithStats = Car & { raceCount: number };

/** A car as returned by GET /cars: the entity without its liveries / trackSetups arrays, plus counts. */
export type CarListItem = Omit<Car, 'liveries' | 'trackSetups'> & {
  raceCount: number;
  liveryCount: number;
  trackSetupCount: number;
};

/** Display name shown next to an uploaded livery: the member's driver-profile display name, else
 * their Discord global/user name, else null (uploader no longer exists). */
export function resolveUploaderName(
  profile: Pick<DriverProfile, 'displayName'> | undefined,
  user: Pick<User, 'discordGlobalName' | 'discordUsername'> | undefined,
): string | null {
  return profile?.displayName?.trim() || user?.discordGlobalName?.trim() || user?.discordUsername || null;
}

@Injectable()
export class CarsService {
  private readonly logger = new Logger(CarsService.name);

  constructor(
    @InjectRepository(Car)
    private readonly carsRepository: Repository<Car>,
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository: Repository<RaceResult>,
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  create(dto: CreateCarDto): Promise<Car> {
    const car = this.carsRepository.create({
      ...dto,
      imageUrl: dto.imageUrl || undefined,
      tankCapacityLiters: String(dto.tankCapacityLiters),
    });
    return this.carsRepository.save(car);
  }

  /** List payload: no nested liveries / trackSetups (a cartesian join per car) — just their counts.
   * GET /cars/:id still returns the full car. */
  async findAll(includeInactive: boolean): Promise<CarListItem[]> {
    const [cars, raceCounts, liveryCounts, setupCounts] = await Promise.all([
      this.carsRepository.find({ where: includeInactive ? {} : { active: true }, order: { name: 'ASC' } }),
      this.raceCountsByCar(),
      this.relatedCountsByCar(Livery),
      this.relatedCountsByCar(CarTrackSetup),
    ]);
    return cars.map(
      (car) =>
        Object.assign(car, {
          raceCount: raceCounts.get(car.id) ?? 0,
          liveryCount: liveryCounts.get(car.id) ?? 0,
          trackSetupCount: setupCounts.get(car.id) ?? 0,
        }) as unknown as CarListItem,
    );
  }

  /** Rows per car in a child table (liveries, track setups), one grouped query each — cars with
   * none are simply absent from the map. */
  private async relatedCountsByCar(entity: typeof Livery | typeof CarTrackSetup): Promise<Map<string, number>> {
    const rows = await this.carsRepository.manager
      .createQueryBuilder(entity, 'child')
      .select('child.carId', 'carId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('child.carId')
      .getRawMany<{ carId: string; count: string }>();
    return new Map(rows.map((row) => [row.carId, Number(row.count)]));
  }

  async findByIdOrThrow(id: string): Promise<Car> {
    const car = await this.carsRepository.findOne({
      where: { id },
      relations: { liveries: true, trackSetups: { track: true } },
    });
    if (!car) {
      throw new NotFoundException('Car not found');
    }
    return car;
  }

  /** Detail payload: the car with liveries' uploader names and its race count resolved. */
  async findOneDetailed(id: string): Promise<CarWithStats> {
    const car = await this.findByIdOrThrow(id);
    await this.attachUploaderNames([car]);
    const raceCount = await this.raceResultsRepository.count({ where: { carId: id } });
    return Object.assign(car, { raceCount });
  }

  async update(id: string, dto: UpdateCarDto): Promise<Car> {
    const car = await this.findByIdOrThrow(id);
    const previousImageUrl = car.imageUrl;
    Object.assign(car, {
      ...dto,
      ...(dto.tankCapacityLiters !== undefined && { tankCapacityLiters: String(dto.tankCapacityLiters) }),
      // An empty string is how the portal clears the image (the DTO has no null).
      ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl || null }),
    });
    const saved = await this.carsRepository.save(car);
    if (dto.imageUrl !== undefined && (dto.imageUrl || null) !== previousImageUrl) {
      await this.deleteUploadedImage(previousImageUrl);
    }
    return saved;
  }

  /** Soft delete — see the `active` column comment on the Car entity. Reversible via
   * PATCH /cars/:id { active: true } (the portal's "Restore"). */
  async deactivate(id: string): Promise<void> {
    const car = await this.findByIdOrThrow(id);
    car.active = false;
    await this.carsRepository.save(car);
  }

  /** race_results rows per car, one grouped query. Cars without any result are simply absent. */
  async raceCountsByCar(): Promise<Map<string, number>> {
    const rows = await this.raceResultsRepository
      .createQueryBuilder('r')
      .select('r.carId', 'carId')
      .addSelect('COUNT(*)', 'count')
      .where('r.carId IS NOT NULL')
      .groupBy('r.carId')
      .getRawMany<{ carId: string; count: string }>();
    return new Map(rows.map((row) => [row.carId, Number(row.count)]));
  }

  /** Fills `uploadedByName` on every livery of the given cars with one users + one profiles
   * lookup (no per-livery queries). */
  async attachUploaderNames(cars: Car[]): Promise<void> {
    const userIds = Array.from(
      new Set(cars.flatMap((car) => (car.liveries ?? []).map((livery) => livery.uploadedByUserId))),
    ).filter(Boolean);
    if (userIds.length === 0) return;

    const [users, profiles] = await Promise.all([
      this.usersRepository.find({ where: { id: In(userIds) } }),
      this.driverProfilesRepository.find({ where: { userId: In(userIds) } }),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const profileByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));

    for (const car of cars) {
      for (const livery of car.liveries ?? []) {
        livery.uploadedByName = resolveUploaderName(
          profileByUserId.get(livery.uploadedByUserId),
          userById.get(livery.uploadedByUserId),
        );
      }
    }
  }

  /** Public URL for a file just stored by the car-image upload endpoint. */
  imageUrlForUpload(file: Express.Multer.File): string {
    return `${CARS_UPLOAD_URL_PREFIX}${file.filename}`;
  }

  /** Only files this app stored itself (under /uploads/cars/) are ever deleted — iRacing CDN
   * URLs and anything else are left alone. */
  private async deleteUploadedImage(imageUrl: string | null): Promise<void> {
    if (!imageUrl || !imageUrl.startsWith(CARS_UPLOAD_URL_PREFIX)) return;
    const filename = imageUrl.slice(CARS_UPLOAD_URL_PREFIX.length);
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) return;
    try {
      await unlink(join(CARS_UPLOAD_DIR, filename));
    } catch (error) {
      this.logger.warn(`Could not delete car image "${filename}": ${(error as Error).message}`);
    }
  }

  /** Idempotent-by-name lookup used by race-result import: a result naming a car not yet on
   * our roster gets a minimal stub car instead of failing the import. `imageUrl` comes from the
   * local iRacing car catalog when RaceResultsService can resolve one (see
   * IracingCarsService.findByIdWithImages()); `carClass` comes from the race result's own
   * car_class_name (confirmed live, e.g. "GT3 Class") — real data, not a guess, in both cases.
   * tankCapacityLiters has no source at all, so it stays a placeholder for an admin to fill in
   * via the normal edit form. */
  async ensureExists(name: string, options?: { imageUrl?: string | null; carClass?: string | null }): Promise<Car> {
    const existing = await this.carsRepository
      .createQueryBuilder('car')
      .where('LOWER(car.name) = LOWER(:name)', { name })
      .getOne();
    if (existing) return existing;

    const car = this.carsRepository.create({
      name,
      carClass: options?.carClass ?? 'Unknown',
      tankCapacityLiters: '0',
      imageUrl: options?.imageUrl ?? null,
      notes: options?.carClass
        ? 'Auto-added from an imported race result — please review tank capacity.'
        : 'Auto-added from an imported race result — please review class and tank capacity.',
    });
    return this.carsRepository.save(car);
  }
}
