import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CarTrackSetup } from './car-track-setup.entity.js';
import { CreateCarTrackSetupDto } from './dto/create-car-track-setup.dto.js';
import { UpdateCarTrackSetupDto } from './dto/update-car-track-setup.dto.js';

@Injectable()
export class CarTrackSetupsService {
  constructor(
    @InjectRepository(CarTrackSetup)
    private readonly setupsRepository: Repository<CarTrackSetup>,
  ) {}

  async create(carId: string, dto: CreateCarTrackSetupDto): Promise<CarTrackSetup> {
    const existing = await this.setupsRepository.findOne({ where: { carId, trackId: dto.trackId } });
    if (existing) {
      throw new ConflictException('A setup for this car and track already exists — edit it instead.');
    }

    const setup = this.setupsRepository.create({
      carId,
      trackId: dto.trackId,
      fuelPerLapLiters: dto.fuelPerLapLiters !== undefined ? String(dto.fuelPerLapLiters) : null,
      pitLaneTimeSeconds: dto.pitLaneTimeSeconds !== undefined ? String(dto.pitLaneTimeSeconds) : null,
      notes: dto.notes ?? null,
    });
    const saved = await this.setupsRepository.save(setup);
    return this.setupsRepository.findOneOrFail({ where: { id: saved.id }, relations: { track: true } });
  }

  async update(id: string, dto: UpdateCarTrackSetupDto): Promise<CarTrackSetup> {
    const setup = await this.setupsRepository.findOne({ where: { id } });
    if (!setup) {
      throw new NotFoundException('Track setup not found');
    }

    Object.assign(setup, {
      ...(dto.fuelPerLapLiters !== undefined && { fuelPerLapLiters: String(dto.fuelPerLapLiters) }),
      ...(dto.pitLaneTimeSeconds !== undefined && { pitLaneTimeSeconds: String(dto.pitLaneTimeSeconds) }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
    });
    await this.setupsRepository.save(setup);
    return this.setupsRepository.findOneOrFail({ where: { id }, relations: { track: true } });
  }

  async remove(id: string): Promise<void> {
    const result = await this.setupsRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Track setup not found');
    }
  }
}
