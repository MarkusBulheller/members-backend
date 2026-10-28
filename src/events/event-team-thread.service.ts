import { ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Car } from '../cars/car.entity.js';
import { Sim } from '../common/enums/sim.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { escapeMarkdown, DiscordBotService } from '../discord-bot/discord-bot.service.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { User } from '../users/user.entity.js';
import { EventSignup } from './event-signup.entity.js';
import { EventTeamDummyDriver } from './event-team-dummy-driver.entity.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTeam } from './event-team.entity.js';
import { buildStintSlots } from './event-team-upcoming-stints.service.js';
import { Event } from './event.entity.js';
import { FollowLinkService } from './follow/follow-link.service.js';

export interface TeamThreadStatus {
  exists: boolean;
  threadId: string | null;
  url: string | null;
}

export interface TeamThreadResult {
  created: boolean;
  threadId: string;
  url: string | null;
}

/** At most this many members are added to a fresh thread. */
export const MAX_THREAD_MEMBERS = 15;
/** At most this many messages per "post plan summary" call. */
export const MAX_SUMMARY_MESSAGES = 8;
/** Discord's hard limit is 2000; stay clear of it. */
export const SUMMARY_MESSAGE_LIMIT = 1900;
/** Minimum time between plan summaries for the same team. */
export const SUMMARY_COOLDOWN_MS = 30_000;

const DISCORD_ID = /^\d{5,25}$/;

function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const unix = (ms: number) => Math.floor(ms / 1000);

/** "6h" / "6h 30m" / "45m". */
export function formatLength(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Thread titles are plain text (no markdown), max 100 chars. */
export function buildThreadName(eventTitle: string, teamName: string): string {
  const name = `${eventTitle} · ${teamName}`.replace(/\s+/g, ' ').trim();
  return name.length <= 100 ? name : `${name.slice(0, 99).trimEnd()}…`;
}

export interface StarterDriver {
  name: string;
  /** Present only for an APPROVED member with a Discord id — they get an @mention. */
  discordId: string | null;
}

export interface StarterInput {
  eventTitle: string;
  sim: Sim;
  trackName: string;
  teamName: string;
  carName: string | null;
  /** Green flag (timeslot + race-start offset) in ms; null when the team has no timeslot yet. */
  raceStartMs: number | null;
  raceLengthMinutes: number;
  drivers: StarterDriver[];
  planUrl: string;
  /** Only passed when the team's public follow link is switched on. */
  followUrl: string | null;
}

/** The thread's first message (also the thread starter). Returns the content and the ids it pings. */
export function buildStarterMessage(input: StarterInput): { content: string; mentionUserIds: string[] } {
  const mentionUserIds: string[] = [];
  const MAX_DRIVERS_LISTED = 25;
  const names = input.drivers.slice(0, MAX_DRIVERS_LISTED).map((d) => {
    if (d.discordId && DISCORD_ID.test(d.discordId)) {
      mentionUserIds.push(d.discordId);
      return `<@${d.discordId}>`;
    }
    return escapeMarkdown(d.name.replace(/\s+/g, ' ').trim());
  });
  if (input.drivers.length > MAX_DRIVERS_LISTED) names.push(`…and ${input.drivers.length - MAX_DRIVERS_LISTED} more`);

  const lines = [
    `🏁 **${escapeMarkdown(input.eventTitle)}** · ${input.sim === Sim.LMU ? 'Le Mans Ultimate' : 'iRacing'}`,
    `**Track:** ${escapeMarkdown(input.trackName)}`,
    `**Team:** ${escapeMarkdown(input.teamName)}${input.carName ? ` · ${escapeMarkdown(input.carName)}` : ''}`,
    input.raceStartMs !== null
      ? `**Green flag:** <t:${unix(input.raceStartMs)}:F> (<t:${unix(input.raceStartMs)}:R>)`
      : '**Green flag:** not scheduled yet',
    `**Race length:** ${formatLength(input.raceLengthMinutes)}`,
    `**Drivers:** ${names.length > 0 ? names.join(', ') : 'none placed yet'}`,
    `**Plan:** ${input.planUrl}`,
    ...(input.followUrl ? [`**Follow live:** ${input.followUrl}`] : []),
  ];
  return { content: lines.join('\n').slice(0, 2000), mentionUserIds };
}

export interface SummaryStint {
  driverName: string | null;
  startsAt: string;
  durationMinutes: number | null;
}

const hhmm = (iso: string) => iso.slice(11, 16);

function formatDuration(minutes: number | null): string {
  if (minutes === null) return '-';
  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Splits the stint plan into Discord messages (each ≤ `limit` chars, at most `maxMessages`).
 * Every message holds a code-block table (# · driver · start UTC · duration) followed by the same
 * stints as Discord timestamps ("Stint 3: <t:..:t> Alex") that render in each reader's own timezone. */
export function buildPlanSummaryMessages(
  teamName: string,
  stints: SummaryStint[],
  raceStartMs: number,
  limit = SUMMARY_MESSAGE_LIMIT,
  maxMessages = MAX_SUMMARY_MESSAGES,
): string[] {
  const clean = (text: string) => text.replace(/[`\r\n]+/g, ' ').trim();
  const NAME_WIDTH = 18;
  const startDay = new Date(raceStartMs).toISOString().slice(0, 10);

  const rows = stints.map((stint, index) => {
    const name = stint.driverName ? clean(stint.driverName) : 'TBD';
    const shown = name.length > NAME_WIDTH ? `${name.slice(0, NAME_WIDTH - 1)}…` : name;
    const dayOffset = Math.round(
      (Date.parse(`${stint.startsAt.slice(0, 10)}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000,
    );
    const start = `${hhmm(stint.startsAt)}${dayOffset > 0 ? `+${dayOffset}` : ''}`;
    const table = `${String(index + 1).padEnd(3)}${shown.padEnd(NAME_WIDTH)} ${start.padEnd(7)} ${formatDuration(stint.durationMinutes)}`;
    const stamp = `Stint ${index + 1}: <t:${unix(Date.parse(stint.startsAt))}:t> ${
      stint.driverName ? escapeMarkdown(clean(stint.driverName)) : 'TBD'
    }`;
    return { table, stamp };
  });

  const head = `**Stint plan - ${escapeMarkdown(clean(teamName))}** (times UTC)`;
  const tableHeader = `${'#'.padEnd(3)}${'Driver'.padEnd(NAME_WIDTH)} ${'Start'.padEnd(7)} Dur`;
  const render = (chunk: typeof rows, title: string | null) =>
    [
      ...(title ? [title] : []),
      '```',
      tableHeader,
      ...chunk.map((r) => r.table),
      '```',
      ...chunk.map((r) => r.stamp),
    ].join('\n');

  const chunks: (typeof rows)[] = [];
  let current: typeof rows = [];
  for (const row of rows) {
    const candidate = [...current, row];
    // Reserve room for the heading and a possible "...and N more" note.
    if (current.length > 0 && render(candidate, head).length > limit - 60) {
      chunks.push(current);
      current = [row];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  const kept = chunks.slice(0, maxMessages);
  const droppedStints = chunks.slice(maxMessages).reduce((sum, c) => sum + c.length, 0);
  const messages = kept.map((chunk, i) => render(chunk, i === 0 ? head : null));
  if (droppedStints > 0 && messages.length > 0) {
    messages[messages.length - 1] += `\n…and ${droppedStints} more stints - see the plan.`;
  }
  return messages;
}

/** One Discord thread per event team: created from a button on the plan page, filled with what the
 * crew needs, and able to receive the stint plan. */
@Injectable()
export class EventTeamThreadService {
  private readonly logger = new Logger(EventTeamThreadService.name);
  /** teamId -> time of the last plan summary (in memory; resets on restart, which is fine). */
  private readonly lastSummaryAt = new Map<string, number>();
  /** teamId -> a thread creation in flight, so a double click can't make two threads. */
  private readonly inflight = new Map<string, Promise<TeamThreadResult>>();

  constructor(
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTeamStint)
    private readonly stintsRepository: Repository<EventTeamStint>,
    @InjectRepository(EventTeamDummyDriver)
    private readonly dummiesRepository: Repository<EventTeamDummyDriver>,
    @InjectRepository(EventSignup)
    private readonly signupsRepository: Repository<EventSignup>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    @InjectRepository(Car)
    private readonly carsRepository: Repository<Car>,
    private readonly discordBot: DiscordBotService,
    private readonly followLinks: FollowLinkService,
    private readonly configService: ConfigService,
  ) {}

  /** Current thread state for the modal. Never throws on a Discord hiccup: if the stored thread
   * can't be verified it is reported as existing. A thread Discord says is gone reads as absent. */
  async getStatus(eventId: string, teamId: string): Promise<TeamThreadStatus> {
    const team = await this.loadTeam(eventId, teamId);
    const threadId = team.discordThreadId ?? null;
    if (!threadId) return { exists: false, threadId: null, url: null };

    try {
      if (!(await this.discordBot.findThreadExists(threadId))) return { exists: false, threadId: null, url: null };
    } catch (err) {
      this.logger.warn(`Could not verify Discord thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { exists: true, threadId, url: await this.threadUrl(threadId) };
  }

  /** Idempotent: an existing, still-alive thread is returned untouched; otherwise one is created. */
  ensureThread(eventId: string, teamId: string, actorUserId: string): Promise<TeamThreadResult> {
    const pending = this.inflight.get(teamId);
    if (pending) return pending;
    const run = this.doEnsureThread(eventId, teamId, actorUserId).finally(() => this.inflight.delete(teamId));
    this.inflight.set(teamId, run);
    return run;
  }

  private async doEnsureThread(eventId: string, teamId: string, actorUserId: string): Promise<TeamThreadResult> {
    const team = await this.loadTeam(eventId, teamId);

    if (team.discordThreadId && (await this.discordBot.findThreadExists(team.discordThreadId))) {
      return { created: false, threadId: team.discordThreadId, url: await this.threadUrl(team.discordThreadId) };
    }

    const parentChannelId = await this.discordBot.getEventsChannelId();
    const event = await this.eventsRepository.findOne({ where: { id: eventId }, relations: { track: true } });
    if (!event) throw new NotFoundException('Event not found');

    const [drivers, carName, followUrl] = await Promise.all([
      this.loadDrivers(teamId),
      team.carId
        ? this.carsRepository.findOne({ where: { id: team.carId }, select: { id: true, name: true } }).then((c) => c?.name ?? null)
        : Promise.resolve(null),
      this.followUrl(eventId, teamId),
    ]);

    const frontendUrl = this.frontendUrl();
    const raceStartMs = team.timeslot
      ? team.timeslot.startsAt.getTime() + (parseDecimal(team.raceStartOffsetMinutes) ?? 0) * 60_000
      : null;
    const starter = buildStarterMessage({
      eventTitle: event.title,
      sim: event.sim,
      trackName: event.track?.name ?? 'TBD',
      teamName: team.name,
      carName,
      raceStartMs,
      raceLengthMinutes: event.raceLengthMinutes,
      drivers,
      planUrl: `${frontendUrl}/events/${eventId}/teams/${teamId}/plan`,
      followUrl,
    });

    const { threadId } = await this.discordBot.createTeamThread({
      parentChannelId,
      name: buildThreadName(event.title, team.name),
      starterContent: starter.content,
      mentionUserIds: starter.mentionUserIds,
    });
    // Saved before the member adds so a failure there can never orphan the thread.
    await this.teamsRepository.update({ id: teamId, eventId }, { discordThreadId: threadId });
    this.logger.log(`Discord thread ${threadId} created for team ${teamId} by ${actorUserId}`);

    const memberIds = [...new Set(drivers.flatMap((d) => (d.discordId ? [d.discordId] : [])))].slice(0, MAX_THREAD_MEMBERS);
    if (memberIds.length > 0) await this.discordBot.addThreadMembers(threadId, memberIds);

    return { created: true, threadId, url: await this.threadUrl(threadId, parentChannelId) };
  }

  /** Posts the stint plan into the team's thread; returns how many messages were posted. */
  async postPlanSummary(eventId: string, teamId: string): Promise<{ posted: number }> {
    const team = await this.loadTeam(eventId, teamId);
    if (!team.discordThreadId) throw new ConflictException('Create the thread first');
    if (!team.timeslot) throw new ConflictException('Choose a start time for this team first');

    const now = Date.now();
    const last = this.lastSummaryAt.get(teamId);
    if (last !== undefined && now - last < SUMMARY_COOLDOWN_MS) {
      const wait = Math.ceil((SUMMARY_COOLDOWN_MS - (now - last)) / 1000);
      throw new HttpException(`The plan summary was just posted - wait ${wait}s before posting it again.`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const event = await this.eventsRepository.findOne({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event not found');
    const stints = await this.stintsRepository.find({ where: { eventTeamId: teamId }, order: { order: 'ASC' } });
    if (stints.length === 0) throw new ConflictException('No stints are planned yet');

    const names = await this.driverNames(stints, teamId);
    const raceStartMs = team.timeslot.startsAt.getTime() + (parseDecimal(team.raceStartOffsetMinutes) ?? 0) * 60_000;
    const slots = buildStintSlots(team, stints, raceStartMs, '', (id) => names.get(id) ?? null, event.sim);
    const messages = buildPlanSummaryMessages(
      team.name,
      slots.map((slot, i) => ({
        driverName: slot.driverName,
        startsAt: slot.startsAt,
        durationMinutes: parseDecimal(stints[i].durationMinutes),
      })),
      raceStartMs,
    );

    // Claimed before posting so a double click can't post twice.
    this.lastSummaryAt.set(teamId, now);
    let posted = 0;
    try {
      for (const content of messages) {
        await this.discordBot.postThreadMessage(team.discordThreadId, content);
        posted += 1;
      }
    } catch (err) {
      if (posted === 0) this.lastSummaryAt.delete(teamId); // nothing went out; allow an immediate retry
      throw err;
    }
    return { posted };
  }

  private async loadTeam(eventId: string, teamId: string): Promise<EventTeam> {
    const team = await this.teamsRepository.findOne({ where: { id: teamId, eventId }, relations: { timeslot: true } });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  private frontendUrl(): string {
    return this.configService.get<string>('FRONTEND_URL', 'http://127.0.0.1:3000').replace(/\/+$/, '');
  }

  /** The public follow link, only when the team has it switched on. */
  private async followUrl(eventId: string, teamId: string): Promise<string | null> {
    const link = await this.followLinks.get(eventId, teamId);
    return link.enabled && link.token ? `${this.frontendUrl()}/follow/${link.token}` : null;
  }

  private async threadUrl(threadId: string, parentChannelId?: string): Promise<string | null> {
    try {
      const channelId = parentChannelId ?? (await this.discordBot.getEventsChannelId());
      const guildId = await this.discordBot.getGuildIdForChannel(channelId);
      return guildId ? `https://discord.com/channels/${guildId}/${threadId}` : null;
    } catch {
      return null;
    }
  }

  /** Everyone on the crew: placed members (signup on this team) then roster guests / placeholders.
   * Only APPROVED members with a Discord id carry a `discordId`. */
  private async loadDrivers(teamId: string): Promise<StarterDriver[]> {
    const [signups, dummies] = await Promise.all([
      this.signupsRepository.find({ where: { eventTeamId: teamId, status: Not(SignupStatus.CANCELLED) } }),
      this.dummiesRepository.find({ where: { eventTeamId: teamId } }),
    ]);
    const userIds = [...new Set(signups.map((s) => s.userId))];
    const [users, profiles] =
      userIds.length > 0
        ? await Promise.all([
            this.usersRepository.find({ where: { id: In(userIds) } }),
            this.driverProfilesRepository.find({ where: { userId: In(userIds) } }),
          ])
        : [[], []];
    const userById = new Map(users.map((u) => [u.id, u]));
    const profileByUser = new Map(profiles.flatMap((p) => (p.userId ? [[p.userId, p] as const] : [])));

    const members: StarterDriver[] = userIds.map((userId) => {
      const user = userById.get(userId);
      const profile = profileByUser.get(userId);
      const name = profile?.iracingName ?? profile?.displayName ?? user?.discordGlobalName ?? user?.discordUsername ?? 'Driver';
      const approved = user?.status === UserStatus.APPROVED && !!user.discordId;
      return { name, discordId: approved ? user!.discordId : null };
    });
    return [...members, ...dummies.map((d) => ({ name: d.name, discordId: null }))];
  }

  /** id (user id or placeholder id) -> display name, for the stints' drivers. */
  private async driverNames(stints: EventTeamStint[], teamId: string): Promise<Map<string, string>> {
    const userIds = [...new Set(stints.flatMap((s) => (s.driverUserId ? [s.driverUserId] : [])))];
    const [profiles, dummies] = await Promise.all([
      userIds.length > 0 ? this.driverProfilesRepository.find({ where: { userId: In(userIds) } }) : Promise.resolve([]),
      this.dummiesRepository.find({ where: { eventTeamId: teamId } }),
    ]);
    const names = new Map<string, string>();
    for (const p of profiles) if (p.userId) names.set(p.userId, p.iracingName ?? p.displayName);
    for (const d of dummies) names.set(d.id, d.name);
    return names;
  }
}
