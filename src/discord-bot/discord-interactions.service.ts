import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { DriversService } from '../drivers/drivers.service.js';
import { EventGuestSignupsService } from '../events/event-guest-signups.service.js';
import { EventSignup } from '../events/event-signup.entity.js';
import { isEventOpenForSignups } from '../events/event-signup-window.js';
import { Event } from '../events/event.entity.js';
import { EventsService } from '../events/events.service.js';
import { User } from '../users/user.entity.js';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';
import { DiscordBotService } from './discord-bot.service.js';
import {
  type DiscordInteraction,
  type DiscordInteractionResponse,
  type DiscordInteractionUser,
  EPHEMERAL_FLAG,
  InteractionResponseType,
  InteractionType,
  type ParsedCustomId,
  parseCustomId,
} from './discord-interactions.types.js';

/** Discord's hard limits for select menus / labels. */
const MAX_SELECT_OPTIONS = 25;
const MAX_LABEL_LENGTH = 100;

const DRAFT_TTL_MS = 15 * 60_000;
const MAX_DRAFTS = 500;

const ALERT_DEDUP_MS = 30 * 60_000;
const MAX_ALERT_ENTRIES = 1000;

const SNOWFLAKE = /^\d{15,25}$/;

const ComponentType = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3 } as const;
const ButtonStyle = { SECONDARY: 2, SUCCESS: 3 } as const;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A start time in UTC — select-menu options can't use Discord's per-viewer timestamp markup, so a
 * fixed, clearly-labelled zone is the only unambiguous choice. */
export function formatSlotLabel(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} · ${hh}:${mm} UTC`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>])/g, '\\$1');
}

/** Who clicked, as far as the signup rules are concerned. */
type ResolvedDriver =
  | { kind: 'member'; user: User }
  | { kind: 'guest'; profile: DriverProfile }
  | { kind: 'unlinked' };

type ReplyKind = 'new' | 'update';

/** The in-progress selections of one clicker for one event (the select menus are stateless on
 * Discord's side, so each click re-sends only that one menu's values). */
interface Draft {
  slotIds: string[];
  firstChoice: string | null;
  carClass: string | null;
  /** Whether the clicker already had a signup when they opened the form. */
  existing: boolean;
  /** Member with exact stint hours set — the quick form leaves those untouched. */
  keepsHours: boolean;
  expiresAt: number;
}

interface ExistingSelection {
  slotIds: string[];
  preference: string[] | null;
  carClass: string | null;
  hasCustomHours: boolean;
}

/** Handles the click flow behind the Sign up / Withdraw buttons on the event post: a private
 * (ephemeral) multi-step form of select menus, then the same signup rules as the portal. */
@Injectable()
export class DiscordInteractionsService {
  private readonly logger = new Logger(DiscordInteractionsService.name);
  private readonly drafts = new Map<string, Draft>();
  private readonly alertedAt = new Map<string, number>();

  constructor(
    @InjectRepository(Event) private readonly eventsRepository: Repository<Event>,
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    private readonly driversService: DriversService,
    @InjectRepository(EventSignup) private readonly signupsRepository: Repository<EventSignup>,
    private readonly eventsService: EventsService,
    private readonly guestSignupsService: EventGuestSignupsService,
    private readonly settingsService: DiscordBotSettingsService,
    private readonly discordBotService: DiscordBotService,
  ) {}

  /** Entry point for an already-verified interaction. Never throws. */
  async handle(interaction: DiscordInteraction): Promise<DiscordInteractionResponse> {
    if (interaction.type === InteractionType.PING) return { type: InteractionResponseType.PONG };

    const user = interaction.member?.user ?? interaction.user;
    if (interaction.type !== InteractionType.MESSAGE_COMPONENT || !user || !SNOWFLAKE.test(String(user.id))) {
      return this.respond('new', 'That action is not supported.');
    }
    if (user.bot) return this.respond('new', "Bots can't sign up.");

    const parsed = parseCustomId(interaction.data?.custom_id);
    if (!parsed) return this.respond('new', 'That button is no longer valid.');

    try {
      return await this.dispatch(parsed, user, interaction.data?.values ?? []);
    } catch (err) {
      this.logger.error('Discord interaction failed', err instanceof Error ? err.stack : String(err));
      const kind = parsed.action === 'sg' || parsed.action === 'wd' ? 'new' : 'update';
      return this.respond(kind, '❌ Something went wrong. Please try again, or sign up on the members site.');
    }
  }

  private async dispatch(
    { action, eventId }: ParsedCustomId,
    user: DiscordInteractionUser,
    values: string[],
  ): Promise<DiscordInteractionResponse> {
    if (action === 'xx') {
      this.drafts.delete(this.draftKey(user.id, eventId));
      return this.respond('update', 'Cancelled — nothing was changed.');
    }

    const kind: ReplyKind = action === 'sg' || action === 'wd' ? 'new' : 'update';
    const event = await this.eventsRepository.findOne({ where: { id: eventId }, relations: { timeslots: true } });
    if (!event) return this.respond(kind, 'This event no longer exists.');

    switch (action) {
      case 'sg':
        return this.startSignup(event, user);
      case 'wd':
        return this.withdraw(event, user);
      case 'st':
      case 'fc':
      case 'cl':
        return this.selectionChanged(action, event, user, values);
      case 'go':
        return this.confirm(event, user);
    }
  }

  // --- sign up ------------------------------------------------------------------------------

  private async startSignup(event: Event, user: DiscordInteractionUser): Promise<DiscordInteractionResponse> {
    if (!isEventOpenForSignups(event)) return this.closed('new', event);

    const driver = await this.resolveDriver(user.id, user.username ?? null);
    if (driver.kind === 'unlinked') return this.unlinked('new', event, user);

    if (this.sortedSlots(event).length === 0) {
      return this.respond('new', 'This event has no start times to choose from yet.');
    }

    const existing = await this.loadExisting(event, driver);
    const draft: Draft = {
      slotIds: existing?.slotIds ?? [],
      firstChoice: existing?.preference && existing.slotIds.length > 1 ? (existing.preference[0] ?? null) : null,
      carClass: this.initialCarClass(event, existing?.carClass ?? null),
      existing: existing !== null,
      keepsHours: existing?.hasCustomHours ?? false,
      expiresAt: 0,
    };
    this.normalizeDraft(event, draft);
    this.saveDraft(this.draftKey(user.id, event.id), draft);
    return this.render('new', event, draft);
  }

  private selectionChanged(
    action: 'st' | 'fc' | 'cl',
    event: Event,
    user: DiscordInteractionUser,
    values: string[],
  ): DiscordInteractionResponse {
    if (!isEventOpenForSignups(event)) return this.closed('update', event);

    const key = this.draftKey(user.id, event.id);
    const draft = this.getDraft(key);
    if (!draft) return this.respond('update', 'This form timed out — tap **Sign up** on the event post to start again.');

    if (action === 'st') {
      draft.slotIds = values;
    } else if (action === 'fc') {
      draft.firstChoice = values[0] ?? null;
    } else {
      draft.carClass = values[0] ?? null;
    }
    this.normalizeDraft(event, draft);
    this.saveDraft(key, draft);
    return this.render('update', event, draft);
  }

  private async confirm(event: Event, user: DiscordInteractionUser): Promise<DiscordInteractionResponse> {
    const key = this.draftKey(user.id, event.id);
    const draft = this.getDraft(key);
    if (!draft) return this.respond('update', 'This form timed out — tap **Sign up** on the event post to start again.');
    if (!isEventOpenForSignups(event)) {
      this.drafts.delete(key);
      return this.closed('update', event);
    }

    const driver = await this.resolveDriver(user.id, user.username ?? null);
    if (driver.kind === 'unlinked') return this.unlinked('update', event, user);

    this.normalizeDraft(event, draft);
    if (!this.isComplete(event, draft)) return this.render('update', event, draft);

    const slots = this.sortedSlots(event).filter((slot) => draft.slotIds.includes(slot.id));
    const first = slots.find((slot) => slot.id === draft.firstChoice) ?? slots[0];
    const ordered = [first, ...slots.filter((slot) => slot.id !== first.id)];
    const timeslotIds = slots.map((slot) => slot.id);
    const timeslotPreference = ordered.map((slot) => slot.id);
    const carClass = event.carClasses.length > 0 ? draft.carClass : null;

    try {
      if (driver.kind === 'member') {
        await this.eventsService.signup(event.id, driver.user.id, {
          timeslotIds,
          timeslotPreference,
          ...(carClass ? { carClass } : {}),
          // New signups are "free for any stint"; an existing signup keeps the exact hours it has.
          ...(draft.keepsHours ? {} : { availableHours: [] }),
        });
      } else {
        await this.guestSignupsService.upsert(event.id, driver.profile.id, { timeslotIds, timeslotPreference, carClass });
      }
    } catch (err) {
      if (err instanceof HttpException) {
        const rendered = this.render('update', event, draft);
        return { ...rendered, data: { ...rendered.data, content: `❌ ${err.message}\n\n${rendered.data?.content ?? ''}` } };
      }
      throw err;
    }

    this.drafts.delete(key);
    const picks = ordered.map((slot, i) => `${ordinal(i + 1)} ${formatSlotLabel(slot.startsAt)}`).join(', ');
    const hoursNote = draft.keepsHours
      ? ' Your exact stint hours were kept.'
      : " Your hours are set to 'any stint' — tap **Set my hours** on the event post to give exact availability.";
    return this.respond(
      'update',
      `✅ You're signed up for **${escapeMarkdown(event.title)}**: ${picks}${carClass ? ` · ${escapeMarkdown(carClass)}` : ''}.${hoursNote}`,
    );
  }

  // --- withdraw -----------------------------------------------------------------------------

  private async withdraw(event: Event, user: DiscordInteractionUser): Promise<DiscordInteractionResponse> {
    const driver = await this.resolveDriver(user.id, user.username ?? null);
    if (driver.kind === 'unlinked') return this.unlinked('new', event, user);

    this.drafts.delete(this.draftKey(user.id, event.id));

    if (driver.kind === 'member') {
      try {
        await this.eventsService.cancelSignup(event.id, driver.user.id);
      } catch (err) {
        // cancelSignup throws NotFound when there is no active signup.
        if (err instanceof HttpException && err.getStatus() === 404) return this.respond('new', "You weren't signed up.");
        throw err;
      }
      return this.respond('new', "You've been withdrawn.");
    }

    const existing = await this.guestSignupsService.findByEventAndProfile(event.id, driver.profile.id);
    if (!existing || existing.status === 'CANCELLED') return this.respond('new', "You weren't signed up.");
    await this.guestSignupsService.cancel(event.id, driver.profile.id);
    return this.respond('new', "You've been withdrawn.");
  }

  // --- who is this ----------------------------------------------------------------------------

  /** Members match strictly by their stable Discord id. Guests are linked by Discord username (the
   * drivers service binds the id on the first match), so the clicker's username is passed along. */
  private async resolveDriver(discordId: string, username: string | null): Promise<ResolvedDriver> {
    const user = await this.usersRepository.findOne({ where: { discordId } });
    if (user) {
      // A known account that isn't approved (pending / rejected / suspended) must not fall through
      // to guest matching — treat it as not linked.
      return user.status === UserStatus.APPROVED ? { kind: 'member', user } : { kind: 'unlinked' };
    }
    const profile = await this.driversService.findGuestByDiscordIdentity(discordId, username);
    return profile ? { kind: 'guest', profile } : { kind: 'unlinked' };
  }

  private async loadExisting(event: Event, driver: ResolvedDriver): Promise<ExistingSelection | null> {
    if (driver.kind === 'member') {
      const signup = await this.signupsRepository.findOne({
        where: { eventId: event.id, userId: driver.user.id },
        relations: { timeslots: true },
      });
      if (!signup || signup.status === SignupStatus.CANCELLED) return null;
      return {
        slotIds: (signup.timeslots ?? []).map((slot) => slot.id),
        preference: signup.timeslotPreference,
        carClass: signup.carClass,
        hasCustomHours: (signup.availableHours ?? []).length > 0,
      };
    }
    if (driver.kind === 'guest') {
      const signup = await this.guestSignupsService.findByEventAndProfile(event.id, driver.profile.id);
      if (!signup || signup.status === 'CANCELLED') return null;
      return {
        slotIds: signup.timeslotIds ?? [],
        preference: signup.timeslotPreference,
        carClass: signup.carClass,
        hasCustomHours: false,
      };
    }
    return null;
  }

  private async unlinked(kind: ReplyKind, event: Event, user: DiscordInteractionUser): Promise<DiscordInteractionResponse> {
    const { alertUserId } = await this.settingsService.getInteractionConfig();
    if (alertUserId) {
      // Fire and forget: the reply must go out inside Discord's 3 seconds, the DM is best-effort.
      void this.alertUnlinked(alertUserId, event, user);
    }
    const contact = alertUserId ? `<@${alertUserId}>` : 'a team admin';
    const username = this.cleanUsername(user);
    return this.respond(
      kind,
      `I couldn't find a driver profile linked to your Discord account${username ? ` (@${username})` : ''}. Please contact ${contact} so they can link you.`,
    );
  }

  private async alertUnlinked(alertUserId: string, event: Event, user: DiscordInteractionUser): Promise<void> {
    const now = Date.now();
    const last = this.alertedAt.get(user.id);
    if (last !== undefined && now - last < ALERT_DEDUP_MS) return;
    this.rememberAlert(user.id, now);

    const username = this.cleanUsername(user);
    const content =
      `<@${user.id}>${username ? ` (@${username})` : ''} tried to sign up for **${escapeMarkdown(event.title)}** ` +
      'but is not linked to a driver profile. Add their Discord username to a guest driver, or ask them to log in to the portal.';
    try {
      const sent = await this.discordBotService.sendDirectMessage(alertUserId, content);
      // A failed DM shouldn't mute the next attempt for half an hour.
      if (!sent) this.alertedAt.delete(user.id);
    } catch (err) {
      this.alertedAt.delete(user.id);
      this.logger.warn(`Alert DM failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private cleanUsername(user: DiscordInteractionUser): string {
    return (user.username ?? '').replace(/[^\w.-]/g, '');
  }

  private rememberAlert(clickerId: string, now: number): void {
    if (this.alertedAt.size >= MAX_ALERT_ENTRIES) {
      for (const [id, at] of this.alertedAt) {
        if (now - at >= ALERT_DEDUP_MS) this.alertedAt.delete(id);
      }
      if (this.alertedAt.size >= MAX_ALERT_ENTRIES) {
        const oldest = this.alertedAt.keys().next().value;
        if (oldest !== undefined) this.alertedAt.delete(oldest);
      }
    }
    this.alertedAt.set(clickerId, now);
  }

  // --- drafts -----------------------------------------------------------------------------------

  private draftKey(clickerId: string, eventId: string): string {
    return `${clickerId}:${eventId}`;
  }

  private getDraft(key: string): Draft | null {
    const draft = this.drafts.get(key);
    if (!draft) return null;
    if (draft.expiresAt <= Date.now()) {
      this.drafts.delete(key);
      return null;
    }
    return draft;
  }

  private saveDraft(key: string, draft: Draft): void {
    const now = Date.now();
    draft.expiresAt = now + DRAFT_TTL_MS;
    // Re-insert so the least recently touched draft is always first in iteration order.
    this.drafts.delete(key);
    if (this.drafts.size >= MAX_DRAFTS) {
      for (const [k, d] of this.drafts) {
        if (d.expiresAt <= now) this.drafts.delete(k);
      }
      while (this.drafts.size >= MAX_DRAFTS) {
        const oldest = this.drafts.keys().next().value;
        if (oldest === undefined) break;
        this.drafts.delete(oldest);
      }
    }
    this.drafts.set(key, draft);
  }

  /** Drops anything that isn't an offered slot / class and keeps the first choice inside the
   * selected slots. Never trusts the values Discord sent back. */
  private normalizeDraft(event: Event, draft: Draft): void {
    const wanted = new Set(draft.slotIds);
    draft.slotIds = this.sortedSlots(event)
      .map((slot) => slot.id)
      .filter((id) => wanted.has(id));
    if (draft.firstChoice !== null && !draft.slotIds.includes(draft.firstChoice)) draft.firstChoice = null;
    if (draft.carClass !== null && !event.carClasses.includes(draft.carClass)) draft.carClass = null;
    if (draft.carClass === null) draft.carClass = this.initialCarClass(event, null);
  }

  private initialCarClass(event: Event, preferred: string | null): string | null {
    if (preferred && event.carClasses.includes(preferred)) return preferred;
    return event.carClasses.length === 1 ? event.carClasses[0] : null;
  }

  private isComplete(event: Event, draft: Draft): boolean {
    return draft.slotIds.length > 0 && (event.carClasses.length <= 1 || draft.carClass !== null);
  }

  // --- rendering ----------------------------------------------------------------------------------

  /** The event's start times, earliest first, capped at what a select menu can hold. */
  private sortedSlots(event: Event) {
    return [...(event.timeslots ?? [])]
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .slice(0, MAX_SELECT_OPTIONS);
  }

  private render(kind: ReplyKind, event: Event, draft: Draft): DiscordInteractionResponse {
    const slots = this.sortedSlots(event);
    const selected = slots.filter((slot) => draft.slotIds.includes(slot.id));
    const components: unknown[] = [
      this.row({
        type: ComponentType.STRING_SELECT,
        custom_id: `st:${event.id}`,
        placeholder: 'Start times you can do',
        min_values: 1,
        max_values: slots.length,
        options: slots.map((slot) => ({
          label: formatSlotLabel(slot.startsAt).slice(0, MAX_LABEL_LENGTH),
          value: slot.id,
          default: draft.slotIds.includes(slot.id),
        })),
      }),
    ];

    if (selected.length >= 2) {
      const effectiveFirst = draft.firstChoice ?? selected[0].id;
      components.push(
        this.row({
          type: ComponentType.STRING_SELECT,
          custom_id: `fc:${event.id}`,
          placeholder: 'Your first choice',
          min_values: 1,
          max_values: 1,
          options: selected.map((slot) => ({
            label: formatSlotLabel(slot.startsAt).slice(0, MAX_LABEL_LENGTH),
            value: slot.id,
            default: slot.id === effectiveFirst,
          })),
        }),
      );
    }

    if (event.carClasses.length > 1) {
      components.push(
        this.row({
          type: ComponentType.STRING_SELECT,
          custom_id: `cl:${event.id}`,
          placeholder: 'Car class',
          min_values: 1,
          max_values: 1,
          options: event.carClasses.slice(0, MAX_SELECT_OPTIONS).map((carClass) => ({
            label: carClass.slice(0, MAX_LABEL_LENGTH),
            value: carClass.slice(0, MAX_LABEL_LENGTH),
            default: carClass === draft.carClass,
          })),
        }),
      );
    }

    components.push(
      this.row(
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SUCCESS,
          label: 'Confirm signup',
          custom_id: `go:${event.id}`,
          disabled: !this.isComplete(event, draft),
        },
        { type: ComponentType.BUTTON, style: ButtonStyle.SECONDARY, label: 'Cancel', custom_id: `xx:${event.id}` },
      ),
    );

    const heading = draft.existing ? 'Update your signup' : 'Sign up';
    const content =
      `**${heading} — ${escapeMarkdown(event.title)}**\n` +
      'Pick every start time you can do' +
      (selected.length >= 2 ? ', then which one you prefer' : '') +
      (event.carClasses.length > 1 ? ' and your car class' : '') +
      '. Times are shown in UTC.';
    return this.respond(kind, content, components);
  }

  private row(...components: unknown[]) {
    return { type: ComponentType.ACTION_ROW, components };
  }

  private closed(kind: ReplyKind, event: Event): DiscordInteractionResponse {
    // The post still shows the buttons if nothing refreshed it since the deadline passed / the
    // event closed — have it rebuilt now.
    if (event.discordMessageId) this.eventsService.scheduleAnnouncementRefreshFor(event.id);
    return this.respond(kind, 'Signups for this event are closed.');
  }

  /** 'new' = a fresh ephemeral message (reply to a button on the public post); 'update' = edit the
   * ephemeral form message the click came from. Components default to none (removes the form). */
  private respond(kind: ReplyKind, content: string, components: unknown[] = []): DiscordInteractionResponse {
    if (kind === 'new') {
      return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content, flags: EPHEMERAL_FLAG, components, allowed_mentions: { parse: [] } },
      };
    }
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content, components, allowed_mentions: { parse: [] } },
    };
  }
}
