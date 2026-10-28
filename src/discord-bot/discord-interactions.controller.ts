import { Controller, Headers, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';
import { verifyDiscordSignature } from './discord-signature.js';
import { DiscordInteractionsService } from './discord-interactions.service.js';
import type { DiscordInteraction, DiscordInteractionResponse } from './discord-interactions.types.js';

/** The "Interactions Endpoint URL" Discord delivers button / select clicks to. Public (no JWT) —
 * authenticity comes from the Ed25519 signature Discord puts on every request, checked against
 * the application public key stored in the Discord bot settings. Needs `rawBody: true` in main.ts
 * since the signature covers the exact bytes Discord sent. */
@Controller('discord')
export class DiscordInteractionsController {
  private readonly logger = new Logger(DiscordInteractionsController.name);

  constructor(
    private readonly settingsService: DiscordBotSettingsService,
    private readonly interactionsService: DiscordInteractionsService,
  ) {}

  @Post('interactions')
  @HttpCode(200)
  async interactions(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature-ed25519') signature: string | undefined,
    @Headers('x-signature-timestamp') timestamp: string | undefined,
  ): Promise<DiscordInteractionResponse> {
    const { publicKey } = await this.settingsService.getInteractionConfig();
    const valid = verifyDiscordSignature({
      publicKeyHex: publicKey,
      signatureHex: signature,
      timestamp,
      rawBody: req.rawBody,
    });
    if (!valid) {
      // Discord shows "The application didn't respond in time" for any non-2xx answer, so say WHY
      // in the server log: no key saved, headers missing (proxy stripped them), or a real mismatch.
      const reason = !publicKey
        ? 'no application public key saved in Admin → Discord bot'
        : !signature || !timestamp
          ? 'signature headers missing (check the reverse proxy forwards X-Signature-* headers)'
          : !req.rawBody
            ? 'raw request body unavailable'
            : 'signature does not match the saved public key (wrong key?) or the timestamp is stale (server clock?)';
      this.logger.warn(`Rejected Discord interaction: ${reason}`);
      throw new UnauthorizedException('invalid request signature');
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(req.rawBody?.toString('utf8') ?? '') as DiscordInteraction;
    } catch {
      this.logger.warn('Discord interaction with an unparseable body');
      throw new UnauthorizedException('invalid request body');
    }
    if (typeof interaction !== 'object' || interaction === null || typeof interaction.type !== 'number') {
      throw new UnauthorizedException('invalid request body');
    }
    return this.interactionsService.handle(interaction);
  }
}
