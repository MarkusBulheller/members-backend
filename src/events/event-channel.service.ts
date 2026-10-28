import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Sim } from '../common/enums/sim.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { DiscordBotService, escapeMarkdown } from '../discord-bot/discord-bot.service.js';
import { EventSignup } from './event-signup.entity.js';
import { formatLength } from './event-team-thread.service.js';
import { Event } from './event.entity.js';

export interface EventChannelStatus {
  exists: boolean;
  channelId: string | null;
  /** https://discord.com/channels/<guild>/<channel>; null when unknown. */
  url: string | null;
}

export interface EventChannelResult {
  /** false = the channel already existed and was left untouched. */
  created: boolean;
  channelId: string;
  url: string | null;
}

/** Start times listed in the first message. */
const MAX_START_TIMES_LISTED = 6;

const unix = (ms: number) => Math.floor(ms / 1000);

/** Discord text channel names: lowercase letters, digits, "-" and "_" (it lowercases and dashes on
 * its own for the API too, but a predictable name is better). Diacritics are folded to ASCII.
 * 2-100 chars; falls back to "event". */
export function buildEventChannelName(title: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 90)
    .replace(/[-_]+$/g, '');
  return folded.length >= 2 ? folded : 'event';
}

export interface EventStarterInput {
  title: string;
  sim: Sim;
  trackName: string;
  carClasses: string[];
  raceLengthMinutes: number;
  /** The candidate start times (or the event's own start when it has none), in ms. */
  startTimesMs: number[];
  signupDeadlineMs: number | null;
  signedUpCount: number;
  eventUrl: string;
}

/** The channel's first message. Nobody is @mentioned. */
export function buildEventStarterMessage(input: EventStarterInput): string {
  const times = [...new Set(input.startTimesMs)].sort((a, b) => a - b);
  const listed = times.slice(0, MAX_START_TIMES_LISTED).map((ms) => `<t:${unix(ms)}:F>`);
  if (times.length > MAX_START_TIMES_LISTED) listed.push(`…and ${times.length - MAX_START_TIMES_LISTED} more`);

  const lines = [
    `🏁 **${escapeMarkdown(input.title)}** · ${input.sim === Sim.LMU ? 'Le Mans Ultimate' : 'iRacing'}`,
    `**Track:** ${escapeMarkdown(input.trackName)}`,
    ...(input.carClasses.length > 0 ? [`**Classes:** ${input.carClasses.map(escapeMarkdown).join(', ')}`] : []),
    `**Race length:** ${formatLength(input.raceLengthMinutes)}`,
    ...(listed.length > 0 ? [`**${times.length > 1 ? 'Start times' : 'Start'}:** ${listed.join(' · ')}`] : []),
    ...(input.signupDeadlineMs !== null ? [`**Sign up by:** <t:${unix(input.signupDeadlineMs)}:F>`] : []),
    `**Signed up:** ${input.signedUpCount}`,
    `**Event page:** ${input.eventUrl}`,
  ];
  return lines.join('\n').slice(0, 2000);
}

/** The channel topic: a one-line summary (plain text, Discord caps it at 1024). */
export function buildEventChannelTopic(trackName: string, raceLengthMinutes: number, eventUrl: string): string {
  return `${trackName} · ${formatLength(raceLengthMinutes)} · ${eventUrl}`.slice(0, 1024);
}

/** One Discord text channel per event (as opposed to EventTeamThreadService's thread per crew):
 * created from the event page inside the category chosen under Admin → Discord Bot, with the
 * event's essentials as the first message. It inherits the category's permissions. */
@Injectable()
export class EventChannelService {
  private readonly logger = new Logger(EventChannelService.name);
  /** eventId -> a creation in flight, so a double click can't make two channels. */
  private readonly inflight = new Map<string, Promise<EventChannelResult>>();

  constructor(
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(EventSignup)
    private readonly signupsRepository: Repository<EventSignup>,
    private readonly discordBot: DiscordBotService,
    private readonly configService: ConfigService,
  ) {}

  /** Never throws on a Discord hiccup: a stored channel that can't be verified reads as existing.
   * A channel Discord says is gone reads as absent. */
  async getStatus(eventId: string): Promise<EventChannelStatus> {
    const event = await this.loadEvent(eventId);
    const channelId = event.discordEventChannelId ?? null;
    if (!channelId) return { exists: false, channelId: null, url: null };
    try {
      if (!(await this.discordBot.findThreadExists(channelId))) return { exists: false, channelId: null, url: null };
    } catch (err) {
      this.logger.warn(`Could not verify Discord channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { exists: true, channelId, url: await this.channelUrl(channelId) };
  }

  /** Idempotent: a live channel is returned untouched; otherwise one is created. */
  ensureChannel(eventId: string, actorUserId: string): Promise<EventChannelResult> {
    const pending = this.inflight.get(eventId);
    if (pending) return pending;
    const run = this.doEnsureChannel(eventId, actorUserId).finally(() => this.inflight.delete(eventId));
    this.inflight.set(eventId, run);
    return run;
  }

  private async doEnsureChannel(eventId: string, actorUserId: string): Promise<EventChannelResult> {
    const event = await this.loadEvent(eventId);
    if (event.discordEventChannelId && (await this.discordBot.findThreadExists(event.discordEventChannelId))) {
      return {
        created: false,
        channelId: event.discordEventChannelId,
        url: await this.channelUrl(event.discordEventChannelId),
      };
    }

    const categoryId = await this.discordBot.getEventCategoryId();
    const signedUpCount = await this.signupsRepository.count({
      where: { eventId, status: Not(SignupStatus.CANCELLED) },
    });
    const eventUrl = `${this.frontendUrl()}/events/${eventId}`;
    const startTimesMs =
      event.timeslots && event.timeslots.length > 0
        ? event.timeslots.map((t) => t.startsAt.getTime())
        : [event.startsAt.getTime()];
    const trackName = event.track?.name ?? 'TBD';

    const { channelId, guildId } = await this.discordBot.createEventChannel({
      categoryId,
      name: buildEventChannelName(event.title),
      topic: buildEventChannelTopic(trackName, event.raceLengthMinutes, eventUrl),
      starterContent: buildEventStarterMessage({
        title: event.title,
        sim: event.sim,
        trackName,
        carClasses: event.carClasses ?? [],
        raceLengthMinutes: event.raceLengthMinutes,
        startTimesMs,
        signupDeadlineMs: event.signupDeadline ? event.signupDeadline.getTime() : null,
        signedUpCount,
        eventUrl,
      }),
    });
    await this.eventsRepository.update({ id: eventId }, { discordEventChannelId: channelId });
    this.logger.log(`Discord channel ${channelId} created for event ${eventId} by ${actorUserId}`);
    return { created: true, channelId, url: `https://discord.com/channels/${guildId}/${channelId}` };
  }

  private async loadEvent(eventId: string): Promise<Event> {
    const event = await this.eventsRepository.findOne({
      where: { id: eventId },
      relations: { track: true, timeslots: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  private frontendUrl(): string {
    return this.configService.get<string>('FRONTEND_URL', 'http://127.0.0.1:3000').replace(/\/+$/, '');
  }

  private async channelUrl(channelId: string): Promise<string | null> {
    const guildId = await this.discordBot.getGuildIdForChannel(channelId);
    return guildId ? `https://discord.com/channels/${guildId}/${channelId}` : null;
  }
}
