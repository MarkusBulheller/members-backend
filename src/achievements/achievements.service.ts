import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AchievementMetric } from '../common/enums/achievement-metric.enum.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { RaceResultDriverStint } from '../race-results/race-result-driver-stint.entity.js';
import { AchievementAward } from './achievement-award.entity.js';
import { AchievementDefinition } from './achievement-definition.entity.js';
import { AchievementTier } from './achievement-tier.entity.js';
import { CreateAchievementAwardDto } from './dto/create-achievement-award.dto.js';
import { CreateAchievementDefinitionDto } from './dto/create-achievement-definition.dto.js';
import { TierDto } from './dto/tier.dto.js';
import { UpdateAchievementDefinitionDto } from './dto/update-achievement-definition.dto.js';

const DEFINITION_RELATIONS = { tiers: true } as const;

@Injectable()
export class AchievementsService {
  constructor(
    @InjectRepository(AchievementDefinition)
    private readonly definitionsRepository: Repository<AchievementDefinition>,
    @InjectRepository(AchievementTier)
    private readonly tiersRepository: Repository<AchievementTier>,
    @InjectRepository(AchievementAward)
    private readonly awardsRepository: Repository<AchievementAward>,
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    @InjectRepository(RaceResultDriverStint)
    private readonly stintsRepository: Repository<RaceResultDriverStint>,
  ) {}

  listDefinitions(): Promise<AchievementDefinition[]> {
    return this.definitionsRepository.find({ relations: DEFINITION_RELATIONS, order: { name: 'ASC' } });
  }

  async createDefinition(dto: CreateAchievementDefinitionDto): Promise<AchievementDefinition> {
    this.validateTierThresholds(dto.metric, dto.tiers);
    this.validateTrackId(dto.metric, dto.trackId);

    const definition = await this.definitionsRepository.save(
      this.definitionsRepository.create({
        name: dto.name,
        description: dto.description ?? null,
        metric: dto.metric,
        trackId: dto.metric === AchievementMetric.TRACK_WIN ? (dto.trackId ?? null) : null,
        ...(dto.icon !== undefined && { icon: dto.icon }),
      }),
    );

    const tiers = dto.tiers.map((tier, index) =>
      this.tiersRepository.create({
        definitionId: definition.id,
        label: tier.label,
        threshold: dto.metric === AchievementMetric.MANUAL ? null : (tier.threshold ?? null),
        sortOrder: index,
      }),
    );
    await this.tiersRepository.save(tiers);

    return this.findDefinitionOrThrow(definition.id);
  }

  async updateDefinition(id: string, dto: UpdateAchievementDefinitionDto): Promise<AchievementDefinition> {
    const definition = await this.findDefinitionOrThrow(id);
    const metric = dto.metric ?? definition.metric;
    const trackId = dto.trackId ?? definition.trackId ?? undefined;

    if (dto.tiers) {
      this.validateTierThresholds(metric, dto.tiers);
    }
    if (dto.metric !== undefined || dto.trackId !== undefined) {
      this.validateTrackId(metric, trackId);
    }

    Object.assign(definition, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.metric !== undefined && { metric: dto.metric }),
      ...(dto.icon !== undefined && { icon: dto.icon }),
      ...((dto.metric !== undefined || dto.trackId !== undefined) && {
        trackId: metric === AchievementMetric.TRACK_WIN ? (trackId ?? null) : null,
      }),
    });
    await this.definitionsRepository.save(definition);

    if (dto.tiers) {
      await this.syncTiers(definition, metric, dto.tiers);
    }

    return this.findDefinitionOrThrow(id);
  }

  /** Keeps any existing tier referenced by id (so already-earned AchievementAwards survive),
   * updates its label/threshold/order, deletes tiers dropped from the payload (cascades to their
   * awards), and creates the rest fresh — mirrors EventsService.syncTimeslots' rationale. */
  private async syncTiers(definition: AchievementDefinition, metric: AchievementMetric, tierDtos: TierDto[]): Promise<void> {
    const existing = definition.tiers ?? [];
    const keepIds = new Set(tierDtos.filter((t) => t.id).map((t) => t.id));

    const toRemove = existing.filter((tier) => !keepIds.has(tier.id));
    if (toRemove.length > 0) {
      await this.tiersRepository.remove(toRemove);
    }

    const toSave = tierDtos.map((tierDto, index) => {
      const current = tierDto.id ? existing.find((t) => t.id === tierDto.id) : undefined;
      const threshold = metric === AchievementMetric.MANUAL ? null : (tierDto.threshold ?? null);
      return current
        ? Object.assign(current, { label: tierDto.label, threshold, sortOrder: index })
        : this.tiersRepository.create({ definitionId: definition.id, label: tierDto.label, threshold, sortOrder: index });
    });
    await this.tiersRepository.save(toSave);
  }

  private validateTierThresholds(metric: AchievementMetric, tiers: TierDto[]): void {
    if (metric !== AchievementMetric.MANUAL && tiers.some((t) => t.threshold === undefined)) {
      throw new BadRequestException(`Every tier needs a threshold for a ${metric} achievement`);
    }
  }

  private validateTrackId(metric: AchievementMetric, trackId: string | undefined): void {
    if (metric === AchievementMetric.TRACK_WIN && !trackId) {
      throw new BadRequestException('A TRACK_WIN achievement needs a track selected');
    }
    if (metric !== AchievementMetric.TRACK_WIN && trackId) {
      throw new BadRequestException('trackId is only valid for a TRACK_WIN achievement');
    }
  }

  async removeDefinition(id: string): Promise<void> {
    const result = await this.definitionsRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Achievement definition not found');
    }
  }

  private async findDefinitionOrThrow(id: string): Promise<AchievementDefinition> {
    const definition = await this.definitionsRepository.findOne({ where: { id }, relations: DEFINITION_RELATIONS });
    if (!definition) {
      throw new NotFoundException('Achievement definition not found');
    }
    definition.tiers.sort((a, b) => a.sortOrder - b.sortOrder);
    return definition;
  }

  /** Sums/counts each driver's metric from RaceResultDriverStint (loaded in-memory and reduced
   * with plain JS, matching StatsService's existing style rather than SQL aggregation), then
   * awards any tier a driver has now met that they didn't already have. The unique
   * (driverProfileId, tierId) index makes this naturally idempotent — re-running never
   * double-awards. */
  async recalculate(definitionId: string): Promise<{ newAwards: number }> {
    const definition = await this.findDefinitionOrThrow(definitionId);
    if (definition.metric === AchievementMetric.MANUAL) {
      throw new BadRequestException('MANUAL achievements have no metric to recalculate — award tiers by hand instead');
    }

    const totals = await this.computeDriverTotals(definition);
    const tiersAscending = [...definition.tiers].sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0));

    const existingAwards = await this.awardsRepository.find({ where: { tierId: In(tiersAscending.map((t) => t.id)) } });
    const alreadyAwarded = new Set(existingAwards.map((a) => `${a.driverProfileId}:${a.tierId}`));

    const today = new Date().toISOString().slice(0, 10);
    const toCreate: AchievementAward[] = [];
    for (const [driverProfileId, total] of totals) {
      for (const tier of tiersAscending) {
        if (tier.threshold !== null && total >= tier.threshold && !alreadyAwarded.has(`${driverProfileId}:${tier.id}`)) {
          toCreate.push(this.awardsRepository.create({ driverProfileId, tierId: tier.id, achievedAt: today, eventId: null }));
        }
      }
    }

    if (toCreate.length > 0) {
      await this.awardsRepository.save(toCreate);
    }
    return { newAwards: toCreate.length };
  }

  /** Loaded in-memory and reduced with plain JS (matching StatsService's existing style rather
   * than SQL aggregation). DISTINCT_CARS_* need the stint's parent RaceResult for its car, and
   * TRACK_WIN needs it for the track — hence the `raceResult` relation, unlike the plain
   * LAPS/WINS/PODIUMS metrics which only look at the stint itself. */
  private async computeDriverTotals(definition: AchievementDefinition): Promise<Map<string, number>> {
    const stints = await this.stintsRepository.find({ relations: { raceResult: true } });

    if (definition.metric === AchievementMetric.DISTINCT_CARS_RACED || definition.metric === AchievementMetric.DISTINCT_CARS_WON) {
      const carsByDriver = new Map<string, Set<string>>();
      for (const stint of stints) {
        if (!stint.driverProfileId) continue;
        if (definition.metric === AchievementMetric.DISTINCT_CARS_WON && stint.finishingPosition !== 1) continue;
        const carKey = stint.raceResult.carId ?? stint.raceResult.carName;
        if (!carKey) continue;
        const cars = carsByDriver.get(stint.driverProfileId) ?? new Set<string>();
        cars.add(carKey);
        carsByDriver.set(stint.driverProfileId, cars);
      }
      return new Map([...carsByDriver].map(([driverProfileId, cars]) => [driverProfileId, cars.size]));
    }

    const totals = new Map<string, number>();
    for (const stint of stints) {
      if (!stint.driverProfileId) continue;
      const isWin = stint.finishingPosition === 1;
      const isPodium = stint.finishingPosition !== null && stint.finishingPosition <= 3;

      const contributes =
        definition.metric === AchievementMetric.LAPS
          ? (stint.lapsComplete ?? 0)
          : definition.metric === AchievementMetric.WINS
            ? isWin
              ? 1
              : 0
            : definition.metric === AchievementMetric.PODIUMS
              ? isPodium
                ? 1
                : 0
              : /* TRACK_WIN */ isWin && stint.raceResult.trackId === definition.trackId
                ? 1
                : 0;

      if (contributes > 0) {
        totals.set(stint.driverProfileId, (totals.get(stint.driverProfileId) ?? 0) + contributes);
      }
    }
    return totals;
  }

  async award(dto: CreateAchievementAwardDto): Promise<AchievementAward> {
    const tier = await this.tiersRepository.findOne({ where: { id: dto.tierId } });
    if (!tier) {
      throw new NotFoundException('Achievement tier not found');
    }
    const driver = await this.driverProfilesRepository.findOne({ where: { id: dto.driverProfileId } });
    if (!driver) {
      throw new NotFoundException('Driver profile not found');
    }

    const existing = await this.awardsRepository.findOne({
      where: { driverProfileId: dto.driverProfileId, tierId: dto.tierId },
    });
    if (existing) {
      throw new ConflictException('This driver already has this tier');
    }

    const award = this.awardsRepository.create({
      driverProfileId: dto.driverProfileId,
      tierId: dto.tierId,
      eventId: dto.eventId ?? null,
      achievedAt: dto.achievedAt ?? new Date().toISOString().slice(0, 10),
    });
    return this.awardsRepository.save(award);
  }

  async revokeAward(id: string): Promise<void> {
    const result = await this.awardsRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Achievement award not found');
    }
  }
}
