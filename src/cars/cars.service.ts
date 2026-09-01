import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Car } from './car.entity.js';
import { CreateCarDto } from './dto/create-car.dto.js';
import { UpdateCarDto } from './dto/update-car.dto.js';

@Injectable()
export class CarsService {
  constructor(
    @InjectRepository(Car)
    private readonly carsRepository: Repository<Car>,
  ) {}

  create(dto: CreateCarDto): Promise<Car> {
    const car = this.carsRepository.create({
      ...dto,
      tankCapacityLiters: String(dto.tankCapacityLiters),
    });
    return this.carsRepository.save(car);
  }

  findAll(includeInactive: boolean): Promise<Car[]> {
    return this.carsRepository.find({
      where: includeInactive ? {} : { active: true },
      relations: { liveries: true, trackSetups: { track: true } },
      order: { name: 'ASC' },
    });
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

  async update(id: string, dto: UpdateCarDto): Promise<Car> {
    const car = await this.findByIdOrThrow(id);
    Object.assign(car, {
      ...dto,
      ...(dto.tankCapacityLiters !== undefined && { tankCapacityLiters: String(dto.tankCapacityLiters) }),
    });
    return this.carsRepository.save(car);
  }

  /** Soft delete — see the `active` column comment on the Car entity. */
  async deactivate(id: string): Promise<void> {
    const car = await this.findByIdOrThrow(id);
    car.active = false;
    await this.carsRepository.save(car);
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
