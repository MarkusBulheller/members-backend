import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { IracingSeriesSeason } from './iracing-series-season.entity.js';
import { IracingService } from './iracing.service.js';

export interface IracingSeriesSeasonWithLogo extends IracingSeriesSeason {
  logoUrl: string | null;
}

/** A season as returned by the list endpoint: everything except the heavy raw `schedule` array
 * (per-race-week track + weather blobs) — GET /iracing/series/:seasonId returns one with it. */
export type IracingSeriesSeasonSummary = Omit<IracingSeriesSeason, 'schedule'> & { logoUrl: string | null };

/** Same labels/field names as the frontend's lib/iracingWeather.ts summarizeRaceWeek() —
 * duplicated here (no shared package between the two projects) since this is the one place the
 * backend needs to render a one-line forecast itself, for Discord announcements. */
const SKIES_LABELS = ['Clear', 'Partly Cloudy', 'Mostly Cloudy', 'Overcast'];

@Injectable()
export class IracingSeriesService {
  private readonly logger = new Logger(IracingSeriesService.name);

  constructor(
    @InjectRepository(IracingSeriesSeason)
    private readonly seriesRepository: Repository<IracingSeriesSeason>,
    private readonly iracingService: IracingService,
    private readonly configService: ConfigService,
  ) {}

  /** Light list: every column except `schedule`, by far the largest part of a season row. */
  async list(): Promise<IracingSeriesSeasonSummary[]> {
    const seasons = await this.seriesRepository.find({
      select: {
        seasonId: true,
        seriesId: true,
        seriesName: true,
        seasonName: true,
        category: true,
        licenseGroup: true,
        official: true,
        active: true,
        logo: true,
        syncedAt: true,
        trackCarUsage: true,
      },
      order: { category: 'ASC', seriesName: 'ASC' },
    });
    return seasons.map((season) => this.withResolvedLogo(season));
  }

  /** One season including its full `schedule` (which the list omits). */
  async getById(seasonId: number): Promise<IracingSeriesSeasonWithLogo> {
    const season = await this.seriesRepository.findOne({ where: { seasonId } });
    if (!season) {
      throw new NotFoundException('Series season not found');
    }
    return this.withResolvedLogo(season);
  }

  /** iRacing's /series/assets gives a bare filename (e.g. "seriesid_374.png") with no `folder`
   * field to join, unlike car/track assets — the endpoint's own "relative to the CDN base" note
   * undersells it: confirmed live that the real path is CDN base + img/logos/series/<filename>,
   * not the CDN base alone. */
  private withResolvedLogo<T extends Pick<IracingSeriesSeason, 'logo'>>(season: T): T & { logoUrl: string | null } {
    const base = this.configService.get<string>('IRACING_IMAGE_BASE_URL', 'https://images-static.iracing.com');
    const logoUrl = season.logo ? `${base}/img/logos/series/${season.logo.replace(/^\/+/, '')}` : null;
    return { ...season, logoUrl };
  }

  /** iRacing issues a brand-new seasonId every ~12 weeks when a series rolls into its next
   * season — since seasonId is this table's primary key, a naive sync would just insert that as
   * an unrelated new row, silently losing the "Track Car Usage" opt-in and leaving the old,
   * now-finished season cluttering the list forever. This carries the opt-in forward and archives
   * whatever it's superseding, both keyed on seriesId (stable across a series' seasons, unlike
   * seasonId). */
  async sync(code: string, codeVerifier: string): Promise<{ synced: number; failed: number; failedSeries: { seriesId: number; name: string }[] }> {
    const { seasons, failedSeriesIds, failedSeries: failedDetails } = await this.iracingService.exchangeCodeForSeriesCatalog(code, codeVerifier);
    const syncedAt = new Date();

    // A series whose schedule could not be fetched keeps its stored seasons untouched: "not in
    // this sync" would otherwise read as "season ended" and archive it and switch its car-usage
    // tracking off. Only series we actually heard back about may be archived below.
    const failedSeries = new Set(failedSeriesIds);
    const syncedSeriesIds = [...new Set(seasons.map((s) => s.seriesId))];
    const incomingSeriesIds = syncedSeriesIds.filter((id) => !failedSeries.has(id));
    const previouslyTracked = await this.seriesRepository.find({
      where: { seriesId: In(syncedSeriesIds), trackCarUsage: true },
    });
    const trackedSeriesIds = new Set(previouslyTracked.map((s) => s.seriesId));

    const entities = seasons.map((season) =>
      this.seriesRepository.create({ ...season, syncedAt, trackCarUsage: trackedSeriesIds.has(season.seriesId) }),
    );
    await this.seriesRepository.save(entities);

    // Anything already in the table for these same series, that this sync did NOT just return,
    // is by definition a previous (now-finished) season of it — iRacing's catalog only ever
    // lists currently-active seasons, so a seriesId's old seasonId simply stops appearing here
    // once it rolls over.
    const incomingSeasonIds = seasons.map((s) => s.seasonId);
    if (incomingSeriesIds.length > 0) {
      await this.seriesRepository
        .createQueryBuilder()
        .update(IracingSeriesSeason)
        .set({ active: false, trackCarUsage: false })
        .where('series_id IN (:...seriesIds)', { seriesIds: incomingSeriesIds })
        .andWhere(incomingSeasonIds.length > 0 ? 'season_id NOT IN (:...seasonIds)' : '1=1', {
          seasonIds: incomingSeasonIds,
        })
        .execute();
    }

    // Name them for the admin: the series name we already have stored beats the decorated season
    // name iRacing's list gives.
    const storedNames = new Map<number, string>();
    if (failedSeries.size > 0) {
      const stored = await this.seriesRepository.find({ where: { seriesId: In([...failedSeries]) } });
      for (const row of stored) if (row.seriesName) storedNames.set(row.seriesId, row.seriesName);
    }
    const failedList = [...new Map(failedDetails.map((f) => [f.seriesId, f])).values()]
      .map((f) => ({ seriesId: f.seriesId, name: storedNames.get(f.seriesId) ?? f.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { synced: entities.length, failed: failedSeries.size, failedSeries: failedList };
  }

  /** Fetches the actual hour-by-hour weather forecast for one race week — iRacing links each
   * cached schedule entry to a presigned S3 JSON file (weather.weather_url) rather than
   * embedding the time series directly. That link is plain HTTPS, no iRacing auth needed, but
   * it's presigned for only 7 days from whenever the season was last synced — if it's expired,
   * this surfaces a clear "re-sync" message rather than a raw fetch failure. */
  async getWeatherForecast(seasonId: number, raceWeekNum: number): Promise<unknown[]> {
    const season = await this.seriesRepository.findOne({ where: { seasonId } });
    if (!season) {
      throw new NotFoundException('Series season not found');
    }

    const week = season.schedule.find(
      (entry) => (entry as Record<string, unknown>)?.race_week_num === raceWeekNum,
    ) as Record<string, unknown> | undefined;
    if (!week) {
      throw new NotFoundException('Race week not found in this season');
    }

    const weather = week.weather as Record<string, unknown> | undefined;
    const weatherUrl = typeof weather?.weather_url === 'string' ? weather.weather_url : null;
    if (!weatherUrl) {
      throw new NotFoundException('No weather forecast available for this race week');
    }

    const response = await fetch(weatherUrl);
    if (!response.ok) {
      this.logger.warn(`Weather forecast fetch failed (season ${seasonId}, week ${raceWeekNum}): ${response.status}`);
      throw new BadGatewayException(
        'The stored weather forecast link has expired — click "Sync" on the Series page to refresh it.',
      );
    }

    const forecast = (await response.json()) as unknown;
    return Array.isArray(forecast) ? forecast : [];
  }

  /** One-line "skies, temp range, rain%" summary for a race week — pulled straight from the
   * schedule entry's own weather_summary (no extra network fetch, unlike getWeatherForecast's
   * presigned S3 link), for use in the Discord event announcement. Returns null wherever the
   * frontend equivalent would fall back to "Weather unavailable". */
  async getRaceWeekWeatherSummary(seasonId: number, raceWeekNum: number): Promise<string | null> {
    const season = await this.seriesRepository.findOne({ where: { seasonId } });
    const week = season?.schedule.find((entry) => (entry as Record<string, unknown>)?.race_week_num === raceWeekNum) as
      | Record<string, unknown>
      | undefined;
    const weather = week?.weather as Record<string, unknown> | undefined;
    if (!weather) return null;
    const s = (weather.weather_summary ?? {}) as Record<string, unknown>;

    const skiesLow = typeof s.skies_low === 'number' ? s.skies_low : typeof weather.skies === 'number' ? weather.skies : null;
    const skiesHigh = typeof s.skies_high === 'number' ? s.skies_high : skiesLow;
    const skies =
      skiesLow === null
        ? null
        : skiesHigh === null || skiesHigh === skiesLow
          ? (SKIES_LABELS[skiesLow] ?? `Skies ${skiesLow}`)
          : `${SKIES_LABELS[skiesLow] ?? skiesLow} – ${SKIES_LABELS[skiesHigh] ?? skiesHigh}`;

    const tempUnit = s.temp_units === 1 || weather.temp_units === 1 ? '°C' : '°F';
    let temp: string | null = null;
    if (typeof s.temp_low === 'number' && typeof s.temp_high === 'number') {
      temp =
        s.temp_low === s.temp_high
          ? `${Math.round(s.temp_low)}${tempUnit}`
          : `${Math.round(s.temp_low)}–${Math.round(s.temp_high)}${tempUnit}`;
    } else if (typeof weather.temp_value === 'number') {
      temp = `${weather.temp_value}${tempUnit}`;
    }

    const rain = typeof s.precip_chance === 'number' ? `${s.precip_chance}% rain` : null;

    return [skies, temp, rain].filter(Boolean).join(', ') || null;
  }
}
