import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sim } from '../common/enums/sim.enum.js';
import { Event } from '../events/event.entity.js';
import { IracingSeriesService } from '../iracing/iracing-series.service.js';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Message flag enabling the Components V2 layout system — required on every field below;
 * without it Discord expects the classic `content`/`embeds` shape instead.
 * https://docs.discord.com/developers/components/reference */
const IS_COMPONENTS_V2 = 1 << 15;

/** Who's signed up, as shown in the announcement — names are resolved by the caller. */
export interface AnnouncementSignup {
  name: string;
  carClass: string | null;
}

/** Where an event's announcement message lives, so it can be edited later. */
export interface AnnouncementRef {
  channelId: string;
  messageId: string;
}

/** 'gone' = Discord says the message no longer exists (deleted), so the caller should forget it. */
export type AnnouncementUpdateResult = 'ok' | 'gone' | 'failed';

const MAX_SIGNUPS_SHOWN = 30;

/** Names come from user-controlled profiles — escape Discord markdown so e.g. an underscore
 * doesn't turn half a name italic. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>])/g, '\\$1');
}

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
  async postEventAnnouncement(event: Event, signups: AnnouncementSignup[]): Promise<AnnouncementRef | null> {
    const { token, channelId } = await this.discordBotSettingsService.getCredentialsForPosting();
    if (!token || !channelId) {
      this.logger.warn('Discord bot token/events channel not configured (see Admin → Discord Bot) — skipping event announcement');
      return null;
    }

    try {
      const weatherSummary = await this.getWeatherSummary(event);
      const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPayload(event, weatherSummary, signups)),
      });
      if (!response.ok) {
        this.logger.error(`Discord announcement failed (${response.status}): ${await response.text()}`);
        return null;
      }
      const message = (await response.json()) as { id?: string; channel_id?: string };
      return message.id ? { channelId: message.channel_id ?? channelId, messageId: message.id } : null;
    } catch (err) {
      this.logger.error('Discord announcement failed', err instanceof Error ? err.stack : String(err));
      return null;
    }
  }

  /** Rewrites an already-posted announcement in place (same content, fresh signup list). Best-effort
   * like posting: never throws. A deleted message comes back as 'gone' so the caller can stop
   * trying to edit it. */
  async updateEventAnnouncement(
    event: Event,
    ref: AnnouncementRef,
    signups: AnnouncementSignup[],
  ): Promise<AnnouncementUpdateResult> {
    const { token } = await this.discordBotSettingsService.getCredentialsForPosting();
    if (!token) {
      this.logger.warn('Discord bot token not configured (see Admin → Discord Bot) — skipping announcement update');
      return 'failed';
    }

    try {
      const weatherSummary = await this.getWeatherSummary(event);
      const response = await fetch(`${DISCORD_API_BASE}/channels/${ref.channelId}/messages/${ref.messageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPayload(event, weatherSummary, signups)),
      });
      if (response.status === 404) return 'gone';
      if (!response.ok) {
        this.logger.error(`Discord announcement update failed (${response.status}): ${await response.text()}`);
        return 'failed';
      }
      return 'ok';
    } catch (err) {
      this.logger.error('Discord announcement update failed', err instanceof Error ? err.stack : String(err));
      return 'failed';
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

  private buildPayload(
    event: Event,
    weatherSummary: string | null,
    signups: AnnouncementSignup[],
  ): { flags: number; allowed_mentions: { parse: string[] }; components: unknown[] } {
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
      `**Sim:** ${event.sim === Sim.LMU ? 'Le Mans Ultimate' : 'iRacing'}`,
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

    const signupLines = signups
      .slice(0, MAX_SIGNUPS_SHOWN)
      .map((s) => `• ${escapeMarkdown(s.name)}${s.carClass ? ` — ${escapeMarkdown(s.carClass)}` : ''}`);
    if (signups.length > MAX_SIGNUPS_SHOWN) {
      signupLines.push(`…and ${signups.length - MAX_SIGNUPS_SHOWN} more`);
    }
    containerComponents.push(
      { type: ComponentType.SEPARATOR },
      {
        type: ComponentType.TEXT_DISPLAY,
        content: `**Signed up (${signups.length}):**\n${signupLines.join('\n') || 'No one yet — be the first!'}`,
      },
    );

    containerComponents.push(
      { type: ComponentType.SEPARATOR },
      { type: ComponentType.TEXT_DISPLAY, content: `[Sign up on the members site](${eventUrl})` },
    );

    return {
      flags: IS_COMPONENTS_V2,
      // Never ping anyone: names in the signup list are user-controlled text.
      allowed_mentions: { parse: [] },
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
