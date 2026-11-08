import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscordBotService } from '../discord-bot/discord-bot.service.js';
import { DISCORD_LIMIT, type RaceReport, buildRaceReport } from './race-report.js';
import { RaceResultsService } from './race-results.service.js';

/** The ready-to-edit race report of an imported result (see buildRaceReport), and posting an edited
 * one to the Discord results channel. */
@Injectable()
export class RaceReportService {
  constructor(
    private readonly raceResults: RaceResultsService,
    private readonly discordBot: DiscordBotService,
    private readonly configService: ConfigService,
  ) {}

  /** 404 for an unknown result. The link in the text is the result's public share link, when it has one. */
  async getDraft(id: string): Promise<RaceReport> {
    const result = await this.raceResults.findByIdOrThrow(id);
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const url = result.shareToken ? `${frontendUrl}/share/results/${result.shareToken}` : null;
    return buildRaceReport(result, url);
  }

  /** Posts the (edited) text to the results channel. Throws 502 when Discord isn't configured or refuses. */
  async post(id: string, text: string): Promise<{ posted: true }> {
    await this.raceResults.findByIdOrThrow(id); // 404 for an unknown result
    const posted = await this.discordBot.postResultsMessage(text.slice(0, DISCORD_LIMIT));
    if (!posted) {
      throw new BadGatewayException(
        'Could not post to Discord. Check the results channel and the bot permissions under Admin → Discord Bot.',
      );
    }
    return { posted: true };
  }
}
