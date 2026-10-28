/** The slice of Discord's interaction payload this app reads.
 * https://docs.discord.com/developers/interactions/receiving-and-responding */
export interface DiscordInteractionUser {
  id: string;
  username?: string;
  bot?: boolean;
}

export interface DiscordInteraction {
  id?: string;
  /** 1 PING, 2 APPLICATION_COMMAND, 3 MESSAGE_COMPONENT, ... */
  type: number;
  application_id?: string;
  token?: string;
  /** Present when the interaction happened in a guild channel. */
  member?: { user?: DiscordInteractionUser };
  /** Present when it happened in a DM with the bot. */
  user?: DiscordInteractionUser;
  data?: { custom_id?: string; component_type?: number; values?: string[] };
}

export const InteractionType = { PING: 1, MESSAGE_COMPONENT: 3 } as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  UPDATE_MESSAGE: 7,
} as const;

/** Message flag: only the clicking user sees the reply. */
export const EPHEMERAL_FLAG = 64;

export interface DiscordInteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    components?: unknown[];
    allowed_mentions?: { parse: string[] };
  };
}

export type InteractionAction = 'sg' | 'wd' | 'st' | 'fc' | 'cl' | 'go' | 'xx';

export interface ParsedCustomId {
  action: InteractionAction;
  eventId: string;
}

const CUSTOM_ID_PATTERN = /^(sg|wd|st|fc|cl|go|xx):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Parses the `<action>:<eventId>` custom ids this app puts on its buttons / selects. Anything
 * else (other bots' leftovers, tampered values) is null and gets ignored. */
export function parseCustomId(customId: unknown): ParsedCustomId | null {
  if (typeof customId !== 'string' || customId.length > 100) return null;
  const match = CUSTOM_ID_PATTERN.exec(customId);
  if (!match) return null;
  return { action: match[1].toLowerCase() as InteractionAction, eventId: match[2].toLowerCase() };
}
