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

  /** iRacing's /car/assets gives `small_image` as a bare filename that needs the per-car
   * `folder` prefixed — per iRacing's own note on that endpoint, confirmed empirically. `logo`
   * is different: it comes back as an already-complete path from the CDN root (e.g.
   * "/img/logos/partners/pontiac-logo.png", sometimes under logos/brand or logos/cars instead —
   * never under the car's own `folder`), so joining it with `folder` too produces a broken,
   * double-nested URL. Base kept as a runtime config value (IRACING_IMAGE_BASE_URL). */
  private withResolvedImages(car: IracingCar): IracingCarWithImages {
    const base = this.configService.get<string>('IRACING_IMAGE_BASE_URL', 'https://images-static.iracing.com');
    const resolveWithFolder = (filename: string | null) => {
      if (!filename || !car.folder) return null;
      return `${base}/${car.folder.replace(/^\/+|\/+$/g, '')}/${filename.replace(/^\/+/, '')}`;
    };
    const resolveLogo = (path: string | null) => (path ? `${base}/${path.replace(/^\/+/, '')}` : null);

    return {
      ...car,
      smallImageUrl: resolveWithFolder(car.smallImage),
      logoUrl: resolveLogo(car.logo),
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
