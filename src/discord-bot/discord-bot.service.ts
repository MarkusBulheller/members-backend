import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Event } from '../events/event.entity.js';
import { IracingSeriesService } from '../iracing/iracing-series.service.js';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Message flag enabling the Components V2 layout system — required on every field below;
 * without it Discord expects the classic `content`/`embeds` shape instead.
 * https://docs.discord.com/developers/components/reference */
const IS_COMPONENTS_V2 = 1 << 15;

const ComponentType = {
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const;

/** Posts event announcements to the team's Discord server via a bot token (REST API, not a
 * persistent gateway connection — a bot posting occasional messages doesn't need discord.js'
 * full Client/gateway, just `Authorization: Bot <token>` on a plain fetch). Distinct from
 * DiscordService (auth/discord.service.ts), which is OAuth-only and uses a member's own user
 * token — this one needs actual bot credentials, configured separately. */
@Injectable()
export class DiscordBotService {
  private readonly logger = new Logger(DiscordBotService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly iracingSeriesService: IracingSeriesService,
    private readonly discordBotSettingsService: DiscordBotSettingsService,
  ) {}

  /** Best-effort: a missing bot config or a Discord outage must never block publishing an event,
   * so every failure is logged rather than thrown — callers should fire this without awaiting a
   * meaningful result (or awaiting at all). */
  async postEventAnnouncement(event: Event): Promise<void> {
    const { token, channelId } = await this.discordBotSettingsService.getCredentialsForPosting();
    if (!token || !channelId) {
      this.logger.warn('Discord bot token/events channel not configured (see Admin → Discord Bot) — skipping event announcement');
      return;
    }

    try {
      const weatherSummary = await this.getWeatherSummary(event);
      const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPayload(event, weatherSummary)),
      });
      if (!response.ok) {
        this.logger.error(`Discord announcement failed (${response.status}): ${await response.text()}`);
      }
    } catch (err) {
      this.logger.error('Discord announcement failed', err instanceof Error ? err.stack : String(err));
    }
  }

  /** Never throws — a weather lookup failure (unsynced season, expired data, etc.) should drop
   * the weather line, not the whole announcement. */
  private async getWeatherSummary(event: Event): Promise<string | null> {
    if (event.iracingSeasonId === null || event.iracingRaceWeekNum === null) {
      return null;
    }
    try {
      return await this.iracingSeriesService.getRaceWeekWeatherSummary(event.iracingSeasonId, event.iracingRaceWeekNum);
    } catch (err) {
      this.logger.warn(
        `Weather summary lookup failed for Discord announcement (event ${event.id})`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  private buildPayload(event: Event, weatherSummary: string | null): { flags: number; components: unknown[] } {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://127.0.0.1:3000');
    const eventUrl = `${frontendUrl}/events/${event.id}`;
    const discordTimestamp = (date: Date) => `<t:${Math.floor(date.getTime() / 1000)}:F>`;

    const titleBlock = event.track.imageUrl
      ? {
          type: ComponentType.SECTION,
          components: [{ type: ComponentType.TEXT_DISPLAY, content: `# 🏁 ${event.title}` }],
          accessory: { type: ComponentType.THUMBNAIL, media: { url: event.track.imageUrl } },
        }
      : { type: ComponentType.TEXT_DISPLAY, content: `# 🏁 ${event.title}` };

    const lengthH = Math.floor(event.raceLengthMinutes / 60);
    const lengthM = event.raceLengthMinutes % 60;
    const lengthLabel = lengthM === 0 ? `${lengthH}h` : `${lengthH}h ${lengthM}m`;

    const details = [
      `**Track:** ${event.track.name}`,
      `**Class${event.carClasses.length > 1 ? 'es' : ''}:** ${event.carClasses.join(' / ')}`,
      `**Length:** ${lengthLabel}`,
      `**Starts:** ${discordTimestamp(event.startsAt)}`,
      ...(weatherSummary ? [`**Weather:** ${weatherSummary}`] : []),
    ].join('\n');

    const containerComponents: unknown[] = [
      titleBlock,
      { type: ComponentType.SEPARATOR },
      { type: ComponentType.TEXT_DISPLAY, content: details },
    ];

    if (event.description) {
      containerComponents.push(
        { type: ComponentType.SEPARATOR },
        { type: ComponentType.TEXT_DISPLAY, content: event.description },
      );
    }

    const timeslotLines = [...event.timeslots]
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((slot) => `• ${discordTimestamp(slot.startsAt)}`)
      .join('\n');
    if (timeslotLines) {
      containerComponents.push(
        { type: ComponentType.SEPARATOR },
        { type: ComponentType.TEXT_DISPLAY, content: `**Available start times:**\n${timeslotLines}` },
      );
    }

    containerComponents.push(
      { type: ComponentType.SEPARATOR },
      { type: ComponentType.TEXT_DISPLAY, content: `[Sign up on the members site](${eventUrl})` },
    );

    return {
      flags: IS_COMPONENTS_V2,
      components: [
        {
          type: ComponentType.CONTAINER,
          accent_color: parseInt('e10600', 16), // W2W red
          components: containerComponents,
        },
      ],
    };
  }
}
