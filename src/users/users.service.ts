import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../common/enums/role.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { User } from './user.entity.js';

export interface DiscordProfileInput {
  discordId: string;
  discordUsername: string;
  discordGlobalName: string | null;
  discordAvatarUrl: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  findByDiscordId(discordId: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { discordId } });
  }

  async findByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('Member not found');
    }
    return user;
  }

  list(status?: UserStatus): Promise<User[]> {
    return this.usersRepository.find({
      where: status ? { status } : {},
      order: { createdAt: 'ASC' },
    });
  }

  /** Member counts per status (one grouped query) — drives the badges on the admin members tabs.
   * Every status is always present (0 when nobody has it); `ALL` is the sum. */
  async countByStatus(): Promise<Record<UserStatus | 'ALL', number>> {
    const rows = await this.usersRepository
      .createQueryBuilder('user')
      .select('user.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('user.status')
      .getRawMany<{ status: UserStatus; count: string }>();

    const counts: Record<UserStatus | 'ALL', number> = {
      [UserStatus.PENDING]: 0,
      [UserStatus.APPROVED]: 0,
      [UserStatus.SUSPENDED]: 0,
      [UserStatus.REJECTED]: 0,
      ALL: 0,
    };
    for (const row of rows) {
      if (row.status in counts) {
        const n = Number(row.count);
        counts[row.status] = n;
        counts.ALL += n;
      }
    }
    return counts;
  }

  /** Creates a new PENDING user from a freshly-verified Discord identity, refreshing the
   * cached Discord profile fields on every sign-in if the user already exists. */
  async upsertFromDiscord(profile: DiscordProfileInput): Promise<User> {
    const existing = await this.findByDiscordId(profile.discordId);

    if (existing) {
      existing.discordUsername = profile.discordUsername;
      existing.discordGlobalName = profile.discordGlobalName;
      existing.discordAvatarUrl = profile.discordAvatarUrl;
      return this.usersRepository.save(existing);
    }

    const created = this.usersRepository.create({
      ...profile,
      role: Role.MEMBER,
      status: UserStatus.PENDING,
    });
    return this.usersRepository.save(created);
  }

  async approve(id: string, approvedByUserId: string): Promise<User> {
    const user = await this.findByIdOrThrow(id);
    user.status = UserStatus.APPROVED;
    user.approvedByUserId = approvedByUserId;
    user.approvedAt = new Date();
    user.rejectionReason = null;
    return this.usersRepository.save(user);
  }

  async reject(id: string, reason?: string): Promise<User> {
    const user = await this.findByIdOrThrow(id);
    user.status = UserStatus.REJECTED;
    user.rejectionReason = reason ?? null;
    user.tokenVersion += 1;
    return this.usersRepository.save(user);
  }

  async suspend(id: string): Promise<User> {
    const user = await this.findByIdOrThrow(id);
    user.status = UserStatus.SUSPENDED;
    user.tokenVersion += 1;
    return this.usersRepository.save(user);
  }

  async updateRole(id: string, role: Role): Promise<User> {
    const user = await this.findByIdOrThrow(id);
    user.role = role;
    return this.usersRepository.save(user);
  }

  /** Directly promotes a user to an approved admin, bypassing the normal approval flow.
   * Used only by the seed-admin script for bootstrapping the first account. */
  async promoteToSeedAdmin(id: string): Promise<User> {
    const user = await this.findByIdOrThrow(id);
    user.role = Role.ADMIN;
    user.status = UserStatus.APPROVED;
    user.approvedAt = new Date();
    return this.usersRepository.save(user);
  }
}
