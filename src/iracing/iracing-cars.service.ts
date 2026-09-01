import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IracingCarData, IracingService } from './iracing.service.js';
import { IracingCar } from './iracing-car.entity.js';

export interface IracingCarWithImages extends IracingCar {
  smallImageUrl: string | null;
  logoUrl: string | null;
}

@Injectable()
export class IracingCarsService {
  constructor(
    @InjectRepository(IracingCar)
    private readonly carsRepository: Repository<IracingCar>,
    private readonly iracingService: IracingService,
    private readonly configService: ConfigService,
  ) {}

  async list(includeRetired: boolean): Promise<IracingCarWithImages[]> {
    const cars = await this.carsRepository.find({
      where: includeRetired ? {} : { retired: false },
      order: { carName: 'ASC' },
    });
    return cars.map((car) => this.withResolvedImages(car));
  }

  /** Exact lookup by iRacing's own car_id — used by RaceResultsService to give an auto-created
   * team Car real image data instead of a blank placeholder. Null if this car was never synced
   * (catalog not synced yet, or synced before this car existed). */
  async findByIdWithImages(carId: number): Promise<IracingCarWithImages | null> {
    const car = await this.carsRepository.findOne({ where: { carId } });
    return car ? this.withResolvedImages(car) : null;
  }

  async sync(code: string, codeVerifier: string): Promise<{ synced: number }> {
    const cars = await this.iracingService.exchangeCodeForCarCatalog(code, codeVerifier);
    const rows = cars.map((car) => this.toEntity(car));
    if (rows.length > 0) {
      await this.carsRepository.upsert(rows, ['carId']);
    }
    return { synced: rows.length };
  }

  /** iRacing's /car/assets gives filenames + a separate `folder` — per iRacing's own note on
   * that endpoint, the full path is folder/filename, relative to the CDN base. Base kept as a
   * runtime config value (IRACING_IMAGE_BASE_URL) since it was confirmed empirically and may
   * need correcting later. */
  private withResolvedImages(car: IracingCar): IracingCarWithImages {
    const base = this.configService.get<string>('IRACING_IMAGE_BASE_URL', 'https://images-static.iracing.com');
    const resolve = (filename: string | null) => {
      if (!filename || !car.folder) return null;
      return `${base}/${car.folder.replace(/^\/+|\/+$/g, '')}/${filename.replace(/^\/+/, '')}`;
    };

    return {
      ...car,
      smallImageUrl: resolve(car.smallImage),
      logoUrl: resolve(car.logo),
    };
  }

  private toEntity(car: IracingCarData): Partial<IracingCar> {
    return {
      carId: car.car_id,
      carName: car.car_name,
      carNameAbbreviated: car.car_name_abbreviated,
      carMake: car.car_make ?? null,
      carModel: car.car_model ?? null,
      categories: Array.isArray(car.categories) ? car.categories.join(', ') : null,
      retired: car.retired,
      smallImage: car.small_image ?? null,
      logo: car.logo ?? null,
      folder: car.folder ?? null,
    };
  }
}
