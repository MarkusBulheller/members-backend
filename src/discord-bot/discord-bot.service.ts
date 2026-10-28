import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sim } from '../common/enums/sim.enum.js';
import { Event } from '../events/event.entity.js';
import { isEventOpenForSignups } from '../events/event-signup-window.js';
import { IracingSeriesService } from '../iracing/iracing-series.service.js';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const CHANNEL_HINT =
  " Check the bot's permissions: it needs Manage Channels (on the server or on the event category), View Channel and Send Messages.";

/** Message flag enabling the Components V2 layout system — required on every field below;
 * without it Discord expects the classic `content`/`embeds` shape instead.
 * https://docs.discord.com/developers/components/reference */
const IS_COMPONENTS_V2 = 1 << 15;

/** Who's signed up, as shown in the announcement — names are resolved by the caller. */
export interface AnnouncementSignup {
  name: string;
  carClass: string | null;
  /** A guest driver (no portal account) — listed with a "(guest)" marker. */
  guest?: boolean;
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
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>])/g, '\\$1');
}

const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const;

const ButtonStyle = { SECONDARY: 2, SUCCESS: 3, LINK: 5 } as const;

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

  /** DMs a Discord user (opens the DM channel, then posts). Best-effort: returns false and logs on
   * any failure (no token, user has DMs closed, outage) — never throws. */
  async sendDirectMessage(userId: string, content: string): Promise<boolean> {
    const { token } = await this.discordBotSettingsService.getCredentialsForPosting();
    if (!token) {
      this.logger.warn('Discord bot token not configured (see Admin → Discord Bot) — skipping direct message');
      return false;
    }
    try {
      const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
      const channelResponse = await fetch(`${DISCORD_API_BASE}/users/@me/channels`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (!channelResponse.ok) {
        this.logger.error(`Discord DM channel creation failed (${channelResponse.status}): ${await channelResponse.text()}`);
        return false;
      }
      const channel = (await channelResponse.json()) as { id?: string };
      if (!channel.id) return false;
      const messageResponse = await fetch(`${DISCORD_API_BASE}/channels/${channel.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      if (!messageResponse.ok) {
        this.logger.error(`Discord DM failed (${messageResponse.status}): ${await messageResponse.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error('Discord DM failed', err instanceof Error ? err.stack : String(err));
      return false;
    }
  }

  /** Posts a plain-text message to the race-results channel (Admin → Discord Bot → results channel).
   * Best-effort like every other post: returns true only when Discord accepted it; false (and a log
   * line) when the token/channel isn't configured or Discord refuses — never throws. Mentions are
   * disabled; callers must escape user-controlled text (series/track names) themselves. */
  async postResultsMessage(content: string): Promise<boolean> {
    const { token, channelId } = await this.discordBotSettingsService.getResultsPostingCredentials();
    if (!token || !channelId) {
      this.logger.warn('Discord bot token/results channel not configured (see Admin → Discord Bot) — skipping result message');
      return false;
    }
    try {
      const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      if (!response.ok) {
        this.logger.error(`Discord result message failed (${response.status}): ${await response.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error('Discord result message failed', err instanceof Error ? err.stack : String(err));
      return false;
    }
  }

  // ---- Team threads --------------------------------------------------------------------------
  // Unlike the best-effort posts above, these run on an admin's button press and the admin is
  // waiting for the outcome, so failures THROW (400 = not configured, 502 = Discord said no) with a
  // message that is safe to show in the UI.

  private readonly guildIdByChannel = new Map<string, string>();

  /** The events channel id from Admin → Discord Bot; throws a clear 400 when unset. */
  async getEventsChannelId(): Promise<string> {
    const { channelId } = await this.discordBotSettingsService.getCredentialsForPosting();
    if (!channelId) throw new BadRequestException('Set the events channel first (Admin → Discord Bot).');
    return channelId;
  }

  private async requireToken(): Promise<string> {
    const { token } = await this.discordBotSettingsService.getCredentialsForPosting();
    if (!token) throw new BadRequestException('Set the Discord bot token first (Admin → Discord Bot).');
    return token;
  }

  /** One REST call as the bot. A 429 is retried once after Discord's `retry_after` (capped), since
   * posting several messages in a row can brush the per-channel limit. Network errors become 502. */
  private async threadRequest(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    const init = {
      method,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    try {
      let response = await fetch(`${DISCORD_API_BASE}${path}`, init);
      if (response.status === 429) {
        let waitMs = 1000;
        try {
          const data = (await response.json()) as { retry_after?: number };
          if (typeof data.retry_after === 'number') waitMs = data.retry_after * 1000;
        } catch {
          // keep the default wait
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(waitMs, 0), 5000)));
        response = await fetch(`${DISCORD_API_BASE}${path}`, init);
      }
      return response;
    } catch (err) {
      this.logger.error(`Discord request failed (${method} ${path})`, err instanceof Error ? err.stack : String(err));
      throw new BadGatewayException("Couldn't reach Discord - please try again.");
    }
  }

  private async discordFailure(action: string, response: Response, hintOverride?: string): Promise<BadGatewayException> {
    const detail = await response.text().catch(() => '');
    this.logger.error(`Discord ${action} failed (${response.status}): ${detail}`);
    const hint =
      hintOverride !== undefined
        ? hintOverride
        : response.status === 403
        ? " Check the bot's permissions in the events channel (View Channel, Send Messages, Create Public Threads, Send Messages in Threads)."
        : response.status === 404
          ? ' The channel or message was not found - check the events channel id.'
          : '';
    return new BadGatewayException(`Discord refused to ${action} (${response.status}).${hint}`);
  }

  /** Posts `starterContent` in the parent channel, then opens a PUBLIC thread from that message
   * (auto-archive 7 days). `mentionUserIds` are the only users the starter may ping — never roles
   * or @everyone. If the thread can't be opened the orphan starter message is deleted again. */
  async createTeamThread(input: {
    parentChannelId: string;
    name: string;
    starterContent: string;
    mentionUserIds?: string[];
  }): Promise<{ threadId: string; starterMessageId: string }> {
    const token = await this.requireToken();
    const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Race thread';

    const messageResponse = await this.threadRequest(token, 'POST', `/channels/${input.parentChannelId}/messages`, {
      content: input.starterContent,
      // SUPPRESS_EMBEDS: the plan / follow links shouldn't unfurl into big previews.
      flags: 1 << 2,
      allowed_mentions: { parse: [], users: (input.mentionUserIds ?? []).slice(0, 100) },
    });
    if (!messageResponse.ok) throw await this.discordFailure('post the thread starter message', messageResponse);
    const message = (await messageResponse.json()) as { id?: string };
    if (!message.id) throw new BadGatewayException('Discord did not return the starter message id.');

    const threadResponse = await this.threadRequest(
      token,
      'POST',
      `/channels/${input.parentChannelId}/messages/${message.id}/threads`,
      { name, auto_archive_duration: 10080 },
    );
    if (!threadResponse.ok) {
      const failure = await this.discordFailure('create the thread', threadResponse);
      // Don't leave a starter message without a thread behind (best effort).
      await this.threadRequest(token, 'DELETE', `/channels/${input.parentChannelId}/messages/${message.id}`).catch(
        () => undefined,
      );
      throw failure;
    }
    const thread = (await threadResponse.json()) as { id?: string; guild_id?: string };
    if (!thread.id) throw new BadGatewayException('Discord did not return the thread id.');
    if (thread.guild_id) this.guildIdByChannel.set(input.parentChannelId, thread.guild_id);
    return { threadId: thread.id, starterMessageId: message.id };
  }

  /** The category id for per-event channels from Admin → Discord Bot; throws a clear 400 when unset. */
  async getEventCategoryId(): Promise<string> {
    const { categoryId } = await this.discordBotSettingsService.getEventChannelCredentials();
    if (!categoryId) throw new BadRequestException('Set the event category first (Admin → Discord Bot).');
    return categoryId;
  }

  /** Creates a text channel inside the event category and posts `starterContent` in it. The bot needs
   * Manage Channels (on the server or on that category). Throws a clear error when the category id
   * is wrong or Discord refuses. A failed first message does not undo the channel: it is logged and
   * the channel still counts as created. */
  async createEventChannel(input: {
    categoryId: string;
    name: string;
    topic?: string;
    starterContent: string;
  }): Promise<{ channelId: string; guildId: string }> {
    const token = await this.requireToken();

    const categoryResponse = await this.threadRequest(token, 'GET', `/channels/${input.categoryId}`);
    if (categoryResponse.status === 404) {
      throw new BadRequestException('The event category was not found - check the category id (Admin → Discord Bot).');
    }
    if (!categoryResponse.ok) throw await this.discordFailure('look up the event category', categoryResponse, CHANNEL_HINT);
    const category = (await categoryResponse.json()) as { type?: number; guild_id?: string };
    if (category.type !== 4 || !category.guild_id) {
      throw new BadRequestException('The event category id is not a category - copy the ID of the category itself.');
    }

    const channelResponse = await this.threadRequest(token, 'POST', `/guilds/${category.guild_id}/channels`, {
      name: input.name,
      type: 0,
      parent_id: input.categoryId,
      ...(input.topic ? { topic: input.topic.slice(0, 1024) } : {}),
    });
    if (!channelResponse.ok) throw await this.discordFailure('create the channel', channelResponse, CHANNEL_HINT);
    const channel = (await channelResponse.json()) as { id?: string };
    if (!channel.id) throw new BadGatewayException('Discord did not return the channel id.');
    this.guildIdByChannel.set(channel.id, category.guild_id);

    try {
      const messageResponse = await this.threadRequest(token, 'POST', `/channels/${channel.id}/messages`, {
        content: input.starterContent,
        flags: 1 << 2,
        allowed_mentions: { parse: [] },
      });
      if (!messageResponse.ok) {
        this.logger.warn(`Discord event channel ${channel.id} created but the first message failed (${messageResponse.status})`);
      }
    } catch (err) {
      this.logger.warn(`Discord event channel ${channel.id} created but the first message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { channelId: channel.id, guildId: category.guild_id };
  }

  /** Adds one user to a thread. Returns false (and logs) on any failure — never throws. */
  async addThreadMember(threadId: string, userId: string): Promise<boolean> {
    let token: string;
    try {
      token = await this.requireToken();
    } catch {
      return false;
    }
    return this.putThreadMember(token, threadId, userId);
  }

  /** Adds many users, one after the other (rate limits). Per-user failures are swallowed; the
   * counts say how it went. */
  async addThreadMembers(threadId: string, userIds: string[]): Promise<{ added: number; failed: number }> {
    let token: string;
    try {
      token = await this.requireToken();
    } catch {
      return { added: 0, failed: userIds.length };
    }
    let added = 0;
    let failed = 0;
    for (const userId of userIds) {
      if (await this.putThreadMember(token, threadId, userId)) added += 1;
      else failed += 1;
    }
    return { added, failed };
  }

  private async putThreadMember(token: string, threadId: string, userId: string): Promise<boolean> {
    try {
      const response = await this.threadRequest(token, 'PUT', `/channels/${threadId}/thread-members/${userId}`);
      if (!response.ok) {
        this.logger.warn(`Discord add-thread-member failed (${response.status}) for user ${userId}`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Plain-text message inside a thread. Only `mentionUserIds` can be pinged. Throws on failure. */
  async postThreadMessage(threadId: string, content: string, mentionUserIds: string[] = []): Promise<string> {
    const token = await this.requireToken();
    const response = await this.threadRequest(token, 'POST', `/channels/${threadId}/messages`, {
      content,
      allowed_mentions: { parse: [], users: mentionUserIds.slice(0, 100) },
    });
    if (!response.ok) throw await this.discordFailure('post into the thread', response);
    const message = (await response.json()) as { id?: string };
    return message.id ?? '';
  }

  /** True while the thread exists; false once Discord answers 404 (deleted). Any other failure
   * throws, so a hiccup is never mistaken for "deleted" (which would create a duplicate thread). */
  async findThreadExists(threadId: string): Promise<boolean> {
    const token = await this.requireToken();
    const response = await this.threadRequest(token, 'GET', `/channels/${threadId}`);
    if (response.status === 404) return false;
    if (!response.ok) throw await this.discordFailure('look up the thread', response);
    return true;
  }

  /** The server (guild) a channel belongs to, needed for https://discord.com/channels/<guild>/<thread>
   * links. Cached in memory; null when it can't be determined. Never throws. */
  async getGuildIdForChannel(channelId: string): Promise<string | null> {
    const cached = this.guildIdByChannel.get(channelId);
    if (cached) return cached;
    try {
      const { token } = await this.discordBotSettingsService.getCredentialsForPosting();
      if (!token) return null;
      const response = await this.threadRequest(token, 'GET', `/channels/${channelId}`);
      if (!response.ok) return null;
      const channel = (await response.json()) as { guild_id?: string };
      if (!channel.guild_id) return null;
      this.guildIdByChannel.set(channelId, channel.guild_id);
      return channel.guild_id;
    } catch {
      return null;
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
      .map(
        (s) =>
          `• ${escapeMarkdown(s.name)}${s.guest ? ' (guest)' : ''}${s.carClass ? ` — ${escapeMarkdown(s.carClass)}` : ''}`,
      );
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

    // Buttons only while signups are open; once the event closes, the next refresh simply
    // rebuilds the post without them.
    if (isEventOpenForSignups(event)) {
      containerComponents.push({
        type: ComponentType.ACTION_ROW,
        components: [
          { type: ComponentType.BUTTON, style: ButtonStyle.SUCCESS, label: 'Sign up', custom_id: `sg:${event.id}` },
          { type: ComponentType.BUTTON, style: ButtonStyle.SECONDARY, label: 'Withdraw', custom_id: `wd:${event.id}` },
          { type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: 'Set my hours', url: eventUrl },
        ],
      });
    }

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
