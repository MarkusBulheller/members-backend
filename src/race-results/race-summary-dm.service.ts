import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { DiscordBotService } from '../discord-bot/discord-bot.service.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { User } from '../users/user.entity.js';
import { buildRaceSummaryText, type SummaryResultInput } from './race-summary-text.js';

/** At most this many DMs per imported result (a crew is far smaller; this only caps a bad import). */
export const MAX_SUMMARY_DMS_PER_IMPORT = 15;
/** The in-memory "already sent" guard is cleared when it grows past this (a restart clears it too). */
const SENT_GUARD_LIMIT = 5000;

/**
 * Optional Discord DM with each driver's personal race summary after a result is imported. OPT-IN:
 * only portal members (profile has a userId, the user is APPROVED and has a Discord id) whose
 * profile has `raceSummaryDm` = true get one. Best-effort and fire-and-forget: notifyImported()
 * never throws and the import never waits on Discord (the caller does not await it). One DM per
 * (result, driver) per process lifetime, guarded in memory - a restart between two attempts could
 * in theory resend, but an import itself can only happen once per result.
 */
@Injectable()
export class RaceSummaryDmService {
  private readonly logger = new Logger(RaceSummaryDmService.name);
  private readonly sent = new Set<string>();

  constructor(
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly discordBotService: DiscordBotService,
    private readonly configService: ConfigService,
  ) {}

  /** The result must carry its driverStints. Never throws. */
  async notifyImported(result: SummaryResultInput): Promise<void> {
    try {
      const profileIds = [
        ...new Set(result.driverStints.map((s) => s.driverProfileId).filter((id): id is string => !!id)),
      ];
      if (profileIds.length === 0) return;

      const profiles = await this.driverProfilesRepository.find({
        where: { id: In(profileIds), raceSummaryDm: true, userId: Not(IsNull()) },
      });
      if (profiles.length === 0) return;

      const users = await this.usersRepository.find({
        where: { id: In(profiles.map((p) => p.userId as string)), status: UserStatus.APPROVED },
      });
      const discordIdByUserId = new Map(users.filter((u) => !!u.discordId).map((u) => [u.id, u.discordId]));

      const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://127.0.0.1:3000');
      const resultUrl = `${frontendUrl}/results/${result.id}`;

      let sentCount = 0;
      for (const profile of profiles) {
        if (sentCount >= MAX_SUMMARY_DMS_PER_IMPORT) {
          this.logger.warn(`Race summary DM limit (${MAX_SUMMARY_DMS_PER_IMPORT}) reached for result ${result.id}`);
          break;
        }
        const discordId = profile.userId ? discordIdByUserId.get(profile.userId) : undefined;
        if (!discordId) continue;

        const key = `${result.id}:${profile.id}`;
        if (this.sent.has(key)) continue;

        const text = buildRaceSummaryText(result, profile.id, resultUrl);
        if (!text) continue;

        if (this.sent.size >= SENT_GUARD_LIMIT) this.sent.clear();
        this.sent.add(key);
        sentCount += 1;
        // Sequential on purpose: opening a DM channel and posting are rate-limited per bot.
        const ok = await this.discordBotService.sendDirectMessage(discordId, text);
        if (!ok) {
          this.logger.warn(`Race summary DM to driver ${profile.id} (result ${result.id}) was not delivered`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Race summary DMs failed for result ${result.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
