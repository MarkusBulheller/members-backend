import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { LIVERIES_UPLOAD_DIR } from './multer.config.js';
import { Livery } from './livery.entity.js';

@Injectable()
export class LiveriesService {
  private readonly logger = new Logger(LiveriesService.name);

  constructor(
    @InjectRepository(Livery)
    private readonly liveriesRepository: Repository<Livery>,
  ) {}

  create(carId: string, file: Express.Multer.File, name: string, uploadedByUserId: string): Promise<Livery> {
    const livery = this.liveriesRepository.create({
      carId,
      imageUrl: `/uploads/liveries/${file.filename}`,
      name,
      uploadedByUserId,
    });
    return this.liveriesRepository.save(livery);
  }

  async remove(id: string): Promise<void> {
    const livery = await this.liveriesRepository.findOne({ where: { id } });
    if (!livery) {
      throw new NotFoundException('Livery not found');
    }

    await this.liveriesRepository.delete(id);

    const filename = livery.imageUrl.split('/').pop();
    if (filename) {
      try {
        await unlink(join(LIVERIES_UPLOAD_DIR, filename));
      } catch (error) {
        this.logger.warn(`Could not delete livery file for ${id}: ${(error as Error).message}`);
      }
    }
  }
}
