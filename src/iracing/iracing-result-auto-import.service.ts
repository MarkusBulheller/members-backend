import { BadGatewayException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { DiscordBotSettingsService } from '../discord-bot/discord-bot-settings.service.js';
import { DiscordBotService } from '../discord-bot/discord-bot.service.js';
import { RaceResult } from '../race-results/race-result.entity.js';
import { RaceResultsService, RaceResultWithTeam } from '../race-results/race-results.service.js';
import { ATTEMPT_STATUSES } from './dto/list-result-attempts-query.dto.js';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { AutoImportRunStatus } from './iracing-auto-import-settings.entity.js';
import { IracingAutoImportSettingsService } from './iracing-auto-import-settings.service.js';
import { buildFoundMessage, buildImportedMessage } from './iracing-auto-import.messages.js';
import { IracingResultAttempt, ResultAttemptStatus } from './iracing-result-attempt.entity.js';
import { IracingTeam } from './iracing-team.entity.js';
import { IracingService, IracingTeamSearchRow } from './iracing.service.js';

/** Imports per run in AUTO mode — each import is several iRacing calls (result, members, laps). */
export const MAX_IMPORTS_PER_RUN = 3;
/** After this many failed import tries an attempt becomes FAILED and is no longer retried. */
export const MAX_TRIES = 5;
/** A new check re-looks this far behind the team's last successful check, so a session that ended
 * inside the previous run's "still too fresh" window (see delayMinutes) is still picked up. */
export const CHECK_OVERLAP_MS = 2 * 60 * 60 * 1000;
/** /results/search_series filters on a session's START time, but we want sessions by when they
 * FINISH. A 24h race that is still running at the previous check started up to a day before the
 * range we'd otherwise ask for, so the search reaches this far back and rows are then filtered
 * locally by end_time. */
export const SEARCH_LOOKBACK_MS = 36 * 60 * 60 * 1000;
/** "iRacing link is gone" alert DMs are rate-limited to one per this interval. */
export const TOKEN_ALERT_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Max "new result available" Discord posts per run (a flood guard after the channel is first set up). */
const MAX_ANNOUNCEMENTS_PER_RUN = 10;

export interface AutoImportRunSummary {
  status: AutoImportRunStatus;
  message: string;
  /** New attempts (sessions seen for the first time) in this run. */
  found: number;
  imported: number;
}

/** GET /iracing/auto-import/attempts item. */
export interface ResultAttemptView {
  id: string;
  subsessionId: number;
  teamId: number;
  teamName: string | null;
  seriesName: string | null;
  trackName: string | null;
  carName: string | null;
  startTime: Date | null;
  endTime: Date | null;
  finishingPositionInClass: number | null;
  finishingPosition: number | null;
  lapsComplete: number | null;
  status: ResultAttemptStatus;
  tries: number;
  lastError: string | null;
  raceResultId: string | null;
  createdAt: Date;
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join('; ');
    if (typeof message === 'string') return message;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Watches the iRacing teams an admin ticked (IracingTeam.autoImport) for newly finished races and
 * either announces them to Discord (mode NOTIFY) or imports them itself (mode AUTO). Runs every 30
 * minutes; see the doc comments on the constants above for the time-window rules. */
@Injectable()
export class IracingResultAutoImportService {
  private readonly logger = new Logger(IracingResultAutoImportService.name);
  private running = false;
  private lastTokenAlertAt = 0;

  constructor(
    @InjectRepository(IracingResultAttempt)
    private readonly attemptsRepository: Repository<IracingResultAttempt>,
    @InjectRepository(IracingTeam)
    private readonly teamsRepository: Repository<IracingTeam>,
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository: Repository<RaceResult>,
    private readonly settingsService: IracingAutoImportSettingsService,
    private readonly adminTokenService: IracingAdminTokenService,
    private readonly iracingService: IracingService,
    private readonly raceResultsService: RaceResultsService,
    private readonly discordBotService: DiscordBotService,
    private readonly discordBotSettingsService: DiscordBotSettingsService,
    private readonly configService: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // The job
  // ---------------------------------------------------------------------------------------------

  /** The scheduler does not skip a tick while the previous run is still going, so an overlap guard
   * lives in run(). Never throws. */
  @Cron('0,30 * * * *')
  async poll(): Promise<void> {
    await this.run();
  }

  /** Runs one check now (cron and POST /iracing/auto-import/run). Never throws. Not recorded in
   * the settings row when it didn't actually run (switched off / a previous check still running). */
  async run(): Promise<AutoImportRunSummary> {
    if (this.running) {
      this.logger.warn('Previous result auto-import check is still running, skipping this run');
      return { status: 'SKIPPED', message: 'A previous check is still running.', found: 0, imported: 0 };
    }
    this.running = true;
    try {
      const settings = await this.settingsService.getRow();
      if (!settings.enabled) {
        return { status: 'SKIPPED', message: 'Auto-import is switched off.', found: 0, imported: 0 };
      }
      let summary: AutoImportRunSummary;
      try {
        summary = await this.check(settings.mode, settings.delayMinutes, settings.enabledSince);
      } catch (error) {
        this.logger.error(`Result auto-import failed: ${errorMessage(error)}`);
        summary = { status: 'ERROR', message: `Check failed: ${errorMessage(error)}`, found: 0, imported: 0 };
      }
      try {
        await this.settingsService.recordRun(summary.status, summary.message);
      } catch (error) {
        this.logger.error(`Recording the auto-import run failed: ${errorMessage(error)}`);
      }
      return summary;
    } catch (error) {
      this.logger.error(`Result auto-import failed: ${errorMessage(error)}`);
      return { status: 'ERROR', message: `Check failed: ${errorMessage(error)}`, found: 0, imported: 0 };
    } finally {
      this.running = false;
    }
  }

  private async check(
    mode: 'NOTIFY' | 'AUTO',
    delayMinutes: number,
    enabledSinceSetting: Date | null,
  ): Promise<AutoImportRunSummary> {
    const teams = await this.teamsRepository.find({ where: { active: true, autoImport: true } });
    if (teams.length === 0) {
      return { status: 'OK', message: 'No teams are being watched (tick teams in the team list).', found: 0, imported: 0 };
    }

    const accessToken = await this.adminTokenService.getSystemAccessToken();
    if (!accessToken) {
      await this.alertNoToken();
      return {
        status: 'SKIPPED',
        message: 'No admin has a working iRacing link — an admin must (re-)link their iRacing account.',
        found: 0,
        imported: 0,
      };
    }

    const now = new Date();
    const cutoffMs = now.getTime() - delayMinutes * 60_000;
    const enabledSince = enabledSinceSetting ?? now;
    let found = 0;
    const errors: string[] = [];

    for (const team of teams) {
      try {
        found += await this.discoverForTeam(accessToken, team, now, cutoffMs, enabledSince);
        // Only after the iRacing search itself succeeded.
        await this.teamsRepository.update({ teamId: team.teamId }, { lastCheckedAt: now });
      } catch (error) {
        this.logger.warn(`Result search for team ${team.teamId} failed: ${errorMessage(error)}`);
        errors.push(`${team.teamName}: ${errorMessage(error)}`);
      }
    }

    const teamNames = new Map(teams.map((team) => [team.teamId, team.teamName]));
    const pending = await this.attemptsRepository.find({
      where: { status: 'FOUND', teamId: In(teams.map((team) => team.teamId)) },
      order: { endTime: 'ASC' },
    });

    let imported = 0;
    let announced = 0;
    if (mode === 'AUTO') {
      for (const attempt of pending) {
        if (imported >= MAX_IMPORTS_PER_RUN) break;
        const outcome = await this.importAttempt(attempt, { source: 'AUTO', accessToken });
        if (outcome.ok) imported += 1;
      }
    } else {
      for (const attempt of pending) {
        if (attempt.announcedAt || announced >= MAX_ANNOUNCEMENTS_PER_RUN) continue;
        const posted = await this.discordBotService.postResultsMessage(
          buildFoundMessage(attempt, teamNames.get(attempt.teamId) ?? null, this.frontendUrl()),
        );
        if (posted) {
          attempt.announcedAt = new Date();
          await this.attemptsRepository.save(attempt);
          announced += 1;
        }
      }
    }

    const parts = [
      `Checked ${teams.length} team${teams.length === 1 ? '' : 's'}`,
      `${found} new result${found === 1 ? '' : 's'} found`,
      mode === 'AUTO' ? `${imported} imported` : `${announced} announced`,
    ];
    let message = parts.join(', ') + '.';
    if (errors.length > 0) message += ` Problems: ${errors.join(' | ')}`;
    return { status: errors.length > 0 ? 'ERROR' : 'OK', message, found, imported };
  }

  /** Searches iRacing for one team and records every new, finished-and-published session as a FOUND
   * attempt. Returns how many attempts were newly created. Throws if the iRacing search fails. */
  private async discoverForTeam(
    accessToken: string,
    team: IracingTeam,
    now: Date,
    cutoffMs: number,
    enabledSince: Date,
  ): Promise<number> {
    const fromMs = team.lastCheckedAt
      ? Math.max(team.lastCheckedAt.getTime() - CHECK_OVERLAP_MS, enabledSince.getTime())
      : enabledSince.getTime();

    const rows = await this.iracingService.searchTeamResultRows(
      accessToken,
      team.teamId,
      new Date(fromMs - SEARCH_LOOKBACK_MS),
      now,
    );

    // Finished after the window start (and after auto-import was switched on), and old enough that
    // iRacing has published it; a row without an end_time can't be judged, so it is skipped.
    const candidates = new Map<number, IracingTeamSearchRow>();
    for (const row of rows) {
      const endMs = row.endTime ? Date.parse(row.endTime) : NaN;
      if (Number.isNaN(endMs) || endMs < fromMs || endMs > cutoffMs) continue;
      candidates.set(row.subsessionId, row);
    }
    if (candidates.size === 0) return 0;

    const subsessionIds = [...candidates.keys()];
    const existingResults = await this.raceResultsRepository.find({
      where: { subsessionId: In(subsessionIds), teamId: In([team.teamId, -team.teamId]) },
      select: { id: true, subsessionId: true },
    });
    const resultBySubsession = new Map(existingResults.map((result) => [result.subsessionId, result.id]));
    const existingAttempts = await this.attemptsRepository.find({
      where: { subsessionId: In(subsessionIds), teamId: team.teamId },
    });
    const attemptBySubsession = new Map(existingAttempts.map((attempt) => [attempt.subsessionId, attempt]));

    let created = 0;
    for (const [subsessionId, row] of candidates) {
      const attempt = attemptBySubsession.get(subsessionId);
      const raceResultId = resultBySubsession.get(subsessionId);

      if (raceResultId) {
        // Already imported (e.g. by hand): make sure the attempt, if any, agrees.
        if (attempt && attempt.status !== 'IMPORTED') {
          attempt.status = 'IMPORTED';
          attempt.raceResultId = raceResultId;
          attempt.lastError = null;
          await this.attemptsRepository.save(attempt);
        }
        continue;
      }
      if (attempt && (attempt.status === 'IMPORTED' || attempt.status === 'IGNORED')) continue;

      if (attempt) {
        this.applyRow(attempt, row);
        await this.attemptsRepository.save(attempt);
      } else {
        const fresh = this.attemptsRepository.create({
          subsessionId,
          teamId: team.teamId,
          status: 'FOUND',
          tries: 0,
          lastError: null,
          raceResultId: null,
          announcedAt: null,
        });
        this.applyRow(fresh, row);
        await this.attemptsRepository.save(fresh);
        created += 1;
      }
    }
    return created;
  }

  private applyRow(attempt: IracingResultAttempt, row: IracingTeamSearchRow): void {
    attempt.seriesName = row.seriesName ?? attempt.seriesName ?? null;
    attempt.trackName = row.trackName ?? attempt.trackName ?? null;
    attempt.carName = row.carName ?? attempt.carName ?? null;
    attempt.startTime = row.startTime ? new Date(row.startTime) : (attempt.startTime ?? null);
    attempt.endTime = row.endTime ? new Date(row.endTime) : (attempt.endTime ?? null);
    attempt.finishingPositionInClass = row.finishingPositionInClass ?? attempt.finishingPositionInClass ?? null;
    attempt.finishingPosition = row.finishingPosition ?? attempt.finishingPosition ?? null;
    attempt.lapsComplete = row.lapsComplete ?? attempt.lapsComplete ?? null;
  }

  // ---------------------------------------------------------------------------------------------
  // Importing one attempt (AUTO from the job, MANUAL from the admin's Import button)
  // ---------------------------------------------------------------------------------------------

  /** Imports the attempt's session through RaceResultsService and updates the attempt. In AUTO an
   * attempt stays FOUND (and is retried next run) until MAX_TRIES failures, then becomes FAILED
   * with one DM alert; a manual try that fails sets FAILED straight away. Never throws. */
  private async importAttempt(
    attempt: IracingResultAttempt,
    options: { source: 'AUTO'; accessToken: string } | { source: 'MANUAL'; adminUserId: string },
  ): Promise<{ ok: true; result: RaceResultWithTeam | null } | { ok: false; error: unknown }> {
    try {
      const result = await this.raceResultsService.importWithOptions(attempt.subsessionId, attempt.teamId, options);
      attempt.status = 'IMPORTED';
      attempt.raceResultId = result.id;
      attempt.lastError = null;
      await this.attemptsRepository.save(attempt);
      await this.discordBotService.postResultsMessage(buildImportedMessage(result, this.frontendUrl()));
      return { ok: true, result };
    } catch (error) {
      if (error instanceof ConflictException) {
        // Already imported by someone else in the meantime: link to it instead of failing.
        const existing = await this.raceResultsRepository.findOne({
          where: { subsessionId: attempt.subsessionId, teamId: In([attempt.teamId, -attempt.teamId]) },
          select: { id: true },
        });
        if (existing) {
          attempt.status = 'IMPORTED';
          attempt.raceResultId = existing.id;
          attempt.lastError = null;
          await this.attemptsRepository.save(attempt);
          return { ok: true, result: null };
        }
      }

      attempt.tries += 1;
      attempt.lastError = errorMessage(error).slice(0, 1000);
      attempt.status = options.source === 'MANUAL' || attempt.tries >= MAX_TRIES ? 'FAILED' : 'FOUND';
      try {
        await this.attemptsRepository.save(attempt);
      } catch (saveError) {
        this.logger.error(`Saving failed attempt ${attempt.id} failed: ${errorMessage(saveError)}`);
      }
      this.logger.warn(
        `Importing subsession ${attempt.subsessionId} for team ${attempt.teamId} failed (try ${attempt.tries}): ${attempt.lastError}`,
      );
      if (options.source === 'AUTO' && attempt.tries === MAX_TRIES) {
        await this.sendAlert(
          `⚠️ Auto-import gave up on iRacing subsession ${attempt.subsessionId} (team ${attempt.teamId}) after ${MAX_TRIES} tries: ${attempt.lastError}. ` +
            'Open the portal auto-import page to retry it by hand.',
        );
      }
      return { ok: false, error };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Admin endpoints
  // ---------------------------------------------------------------------------------------------

  async listAttempts(status?: ResultAttemptStatus, limit = 50): Promise<ResultAttemptView[]> {
    const where: FindOptionsWhere<IracingResultAttempt> = {};
    if (status && ATTEMPT_STATUSES.includes(status)) where.status = status;
    const attempts = await this.attemptsRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
    const teamNames = await this.teamNamesFor(attempts.map((attempt) => attempt.teamId));
    return attempts.map((attempt) => this.toView(attempt, teamNames.get(attempt.teamId) ?? null));
  }

  /** "Import now": 404 unknown id, 409 already imported; on failure the attempt is saved as FAILED
   * with the error and the underlying error (with its HTTP status) is rethrown. */
  async importNow(
    id: string,
    adminUserId: string,
  ): Promise<{ attempt: ResultAttemptView; raceResultId: string }> {
    const attempt = await this.findAttemptOrThrow(id);
    if (attempt.status === 'IMPORTED') {
      throw new ConflictException('This result has already been imported.');
    }

    const outcome = await this.importAttempt(attempt, { source: 'MANUAL', adminUserId });
    if (!outcome.ok) {
      if (outcome.error instanceof HttpException) throw outcome.error;
      throw new BadGatewayException(errorMessage(outcome.error));
    }
    const teamNames = await this.teamNamesFor([attempt.teamId]);
    return {
      attempt: this.toView(attempt, teamNames.get(attempt.teamId) ?? null),
      raceResultId: attempt.raceResultId as string,
    };
  }

  async ignore(id: string): Promise<ResultAttemptView> {
    const attempt = await this.findAttemptOrThrow(id);
    if (attempt.status === 'IMPORTED') {
      throw new ConflictException('This result has already been imported.');
    }
    attempt.status = 'IGNORED';
    await this.attemptsRepository.save(attempt);
    const teamNames = await this.teamNamesFor([attempt.teamId]);
    return this.toView(attempt, teamNames.get(attempt.teamId) ?? null);
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private async findAttemptOrThrow(id: string): Promise<IracingResultAttempt> {
    const attempt = await this.attemptsRepository.findOne({ where: { id } });
    if (!attempt) {
      throw new NotFoundException('Result attempt not found');
    }
    return attempt;
  }

  private async teamNamesFor(teamIds: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(teamIds)];
    if (unique.length === 0) return new Map();
    const teams = await this.teamsRepository.find({ where: { teamId: In(unique.flatMap((id) => [id, -id])) } });
    return new Map(teams.map((team) => [Math.abs(team.teamId), team.teamName]));
  }

  private toView(attempt: IracingResultAttempt, teamName: string | null): ResultAttemptView {
    return {
      id: attempt.id,
      subsessionId: attempt.subsessionId,
      teamId: attempt.teamId,
      teamName,
      seriesName: attempt.seriesName,
      trackName: attempt.trackName,
      carName: attempt.carName,
      startTime: attempt.startTime,
      endTime: attempt.endTime,
      finishingPositionInClass: attempt.finishingPositionInClass,
      finishingPosition: attempt.finishingPosition,
      lapsComplete: attempt.lapsComplete,
      status: attempt.status,
      tries: attempt.tries,
      lastError: attempt.lastError,
      raceResultId: attempt.raceResultId,
      createdAt: attempt.createdAt,
    };
  }

  private frontendUrl(): string {
    return this.configService.get<string>('FRONTEND_URL', 'http://127.0.0.1:3000');
  }

  /** At most one "no working iRacing link" DM per TOKEN_ALERT_INTERVAL_MS. */
  private async alertNoToken(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastTokenAlertAt < TOKEN_ALERT_INTERVAL_MS) return;
    this.lastTokenAlertAt = nowMs;
    await this.sendAlert(
      '⚠️ Result auto-import is paused: no admin has a working iRacing link. ' +
        'An admin needs to re-link their iRacing account (portal → Edit Profile → Link iRacing Account).',
    );
  }

  /** DMs the configured alert user (Admin → Discord Bot); silently nothing if none is set. */
  private async sendAlert(content: string): Promise<void> {
    try {
      const { alertUserId } = await this.discordBotSettingsService.getInteractionConfig();
      if (!alertUserId) return;
      await this.discordBotService.sendDirectMessage(alertUserId, content);
    } catch (error) {
      this.logger.error(`Sending the auto-import alert failed: ${errorMessage(error)}`);
    }
  }
}
