import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const IRACING_OAUTH_BASE = 'https://oauth.iracing.com/oauth2';
const IRACING_DATA_BASE = 'https://members-ng.iracing.com/data';

/** Some Data API endpoints (like /car/get) respond with a bare array; others wrap the array in
 * an envelope object under one of a few possible key names. This tries the bare-array case
 * first, then each candidate key, and falls back to an empty array rather than throwing — the
 * caller logs the raw shape separately so a wrong guess here is diagnosable, not a crash. */
function extractArray(raw: unknown, candidateKeys: string[]): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    for (const key of candidateKeys) {
      const value = (raw as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  return [];
}

interface IracingTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  /** Present unless iRacing chooses to omit it — a refresh token may be exchanged, once, for a
   * fresh access token (and a new refresh token) via the "refresh_token" grant, with no
   * additional scope needed. Used to auto-refresh a member's stats weekly without asking them
   * to re-link — see DriversService.refreshAllIracingStats(). */
  refresh_token?: string;
}

interface IracingIdentity {
  iracing_name: string;
  iracing_cust_id: number;
}

export interface IracingLinkResult {
  name: string;
  custId: number;
  location: string | null;
  countryCode: string | null;
  sportsCarIrating: number | null;
  sportsCarSafetyRating: string | null;
  refreshToken: string | null;
}

export interface IracingTeamRosterMemberData {
  custId: number;
  displayName: string;
}

export interface IracingTeamRosterResult {
  teamId: number;
  teamName: string;
  ownerCustId: number;
  roster: IracingTeamRosterMemberData[];
}

export interface IracingCarData {
  car_id: number;
  car_name: string;
  car_name_abbreviated: string;
  car_make?: string;
  car_model?: string;
  categories: string[];
  retired: boolean;
  /** Raw filenames (not full URLs) — merged in from /car/assets, see
   * exchangeCodeForCarCatalog(). The /car/get response's own small_image/logo fields are
   * unreliable, so these are ignored. Must be joined with `folder` below and the CDN base
   * (https://images-static.iracing.com/) to form a real URL — see IracingCarsService. */
  small_image: string | null;
  logo: string | null;
  /** The per-car asset folder these filenames live in — NOT part of the filename itself. */
  folder: string | null;
}

interface IracingCarAssetData {
  car_id: number;
  small_image?: string;
  logo?: string;
  folder?: string;
}

export interface IracingTrackData {
  track_id: number;
  track_name: string;
  config_name: string | null;
  category: string | null;
  location: string | null;
  retired: boolean;
  /** Same deal as IracingCarData's image fields — merged in from /track/assets, not /track/get
   * (which shares the same unreliable-image-fields pattern as /car/get). */
  small_image: string | null;
  logo: string | null;
  folder: string | null;
}

interface IracingTrackAssetData {
  track_id: number;
  small_image?: string;
  logo?: string;
  folder?: string;
}

export interface IracingSeriesSeasonData {
  seasonId: number;
  seriesId: number;
  seriesName: string;
  seasonName: string;
  category: string | null;
  licenseGroup: number | null;
  official: boolean;
  active: boolean;
  /** Raw per-race-week entries exactly as returned by /series/season_schedule (track + weather
   * per week) — kept opaque since the frontend renders defensively rather than assuming a
   * strict shape. */
  schedule: unknown[];
  /** From /series/assets, keyed by series_id — a path relative to IRACING_IMAGE_BASE_URL, same
   * convention as car/track assets (see IracingSeriesService.withResolvedLogo()). */
  logo: string | null;
}

export interface IracingRaceResultDriverData {
  custId: number;
  displayName: string;
  startingPosition: number | null;
  finishingPosition: number | null;
  averageLapTimeMs: number | null;
  bestLapTimeMs: number | null;
  incidents: number | null;
  lapsComplete: number | null;
  /** General profile snapshot (not race-specific) — used to enrich/auto-create a roster entry
   * for a driver_results cust_id that isn't on our roster yet. Null if unavailable. */
  location: string | null;
  countryCode: string | null;
  sportsCarIrating: number | null;
  sportsCarSafetyRating: string | null;
}

export interface IracingLapData {
  custId: number;
  displayName: string;
  lapNumber: number;
  lapTimeMs: number | null;
  incident: boolean;
  /** iRacing's own running session clock at this lap — not converted to a real time unit since
   * its scale is unconfirmed; only used as a reliable chronological sort key (lap_number can't
   * be trusted for this since it's unclear whether it resets per driver stint). */
  sessionTime: number;
}

export interface IracingRaceResultData {
  subsessionId: number;
  teamId: number;
  seriesName: string | null;
  trackName: string;
  trackConfig: string | null;
  /** iRacing's own numeric track_id — used to look up the local iRacing track catalog (see
   * IracingTracksService) so an auto-created Track can be filled in with real category/location/
   * image data instead of a placeholder. Null if the raw response's track object lacked it. */
  trackId: number | null;
  carName: string | null;
  /** Same idea as trackId, but for the local iRacing car catalog — used to give an auto-created
   * Car a real image. */
  carId: number | null;
  /** e.g. "GT3 Class" — confirmed live on teamResult.car_class_name. Used to give an auto-created
   * Car a real class label instead of a placeholder (see RaceResultsService.importFromIracing). */
  carClassName: string | null;
  startTime: string | null;
  endTime: string | null;
  startingPosition: number | null;
  finishingPosition: number | null;
  /** The team's position within its own car class (e.g. GT3), not overall field position —
   * confirmed live via /results/get's starting_position_in_class/finish_position_in_class,
   * same 0-indexed convention as the overall fields (see toRacePosition()). */
  startingPositionInClass: number | null;
  finishingPositionInClass: number | null;
  teamLapsComplete: number | null;
  totalLaps: number | null;
  teamIncidents: number | null;
  /** From the top-level session_splits array — each entry is a sibling subsession_id for the
   * same event (a race gets split into multiple subsessions when the field is too big for one).
   * splitNumber is this subsession's 1-indexed position in that array (iRacing orders it
   * strongest field first, so Split 1 is the top split); null if session_splits was empty/absent
   * (e.g. the event wasn't split at all). */
  splitNumber: number | null;
  totalSplits: number | null;
  drivers: IracingRaceResultDriverData[];
  laps: IracingLapData[];
}

/** Handles iRacing's OAuth flow server-side and the Data API calls that follow it. The OAuth
 * client is a public/PKCE "single page app" type (no client_secret), but none of iRacing's
 * /token, /iracing/profile, or /data/* endpoints send CORS headers permitting direct browser
 * calls, so all of this has to happen here — a plain server-to-server fetch, not subject to
 * browser CORS. No refresh token is ever stored; each flow exchanges a code for a short-lived
 * access token, uses it once, and discards it. */
@Injectable()
export class IracingService {
  private readonly logger = new Logger(IracingService.name);

  constructor(private readonly configService: ConfigService) {}

  /** The "Identity Verification Workflow" (scope iracing.profile) + a Data API snapshot (scope
   * iracing.auth) of location and Sports Car license stats — see beginIracingLink() in the
   * frontend, which requests both scopes together in one OAuth round trip. */
  async exchangeCodeForLinkResult(code: string, codeVerifier: string): Promise<IracingLinkResult> {
    const { accessToken, refreshToken } = await this.exchangeCodeForToken(code, codeVerifier);
    return this.buildLinkResult(accessToken, refreshToken);
  }

  /** Trades a previously-stored refresh token for a fresh snapshot, without any user
   * interaction — used by the weekly auto-refresh cron (see DriversService). iRacing refresh
   * tokens are single-use, so the caller must persist the returned refreshToken (or null, if
   * iRacing declined to renew it — in which case the member needs to re-link manually). Returns
   * null if the stored refresh token was rejected (revoked/expired). */
  async refreshLinkResult(refreshToken: string): Promise<IracingLinkResult | null> {
    const tokens = await this.refreshAccessToken(refreshToken);
    if (!tokens) return null;
    return this.buildLinkResult(tokens.accessToken, tokens.refreshToken);
  }

  private async buildLinkResult(accessToken: string, refreshToken: string | null): Promise<IracingLinkResult> {
    const identity = await this.fetchIdentity(accessToken);
    const memberInfo = await this.fetchDataApi<Record<string, unknown>>(accessToken, '/member/info');

    return {
      name: identity.iracing_name,
      custId: identity.iracing_cust_id,
      location: extractLocation(memberInfo),
      countryCode: extractCountryCode(memberInfo),
      sportsCarIrating: extractSportsCarIrating(memberInfo),
      sportsCarSafetyRating: extractSportsCarSafetyRating(memberInfo),
      refreshToken,
    };
  }

  /** iRacing's full car catalog (scope iracing.auth only — not member-specific, just a
   * generic Data API read). Used to refresh the local IracingCar cache — see
   * IracingCarsService.sync(). Merges in /car/assets, since /car/get's own image fields are
   * unreliable — /car/assets responds with a map keyed by car_id (as a string). */
  async exchangeCodeForCarCatalog(code: string, codeVerifier: string): Promise<IracingCarData[]> {
    const { accessToken } = await this.exchangeCodeForToken(code, codeVerifier);
    const [cars, assets] = await Promise.all([
      this.fetchDataApi<IracingCarData[]>(accessToken, '/car/get'),
      this.fetchDataApi<Record<string, IracingCarAssetData>>(accessToken, '/car/assets'),
    ]);

    return (cars ?? []).map((car) => {
      const asset = assets?.[String(car.car_id)];
      return {
        ...car,
        small_image: asset?.small_image ?? null,
        logo: asset?.logo ?? null,
        folder: asset?.folder ?? null,
      };
    });
  }

  /** iRacing's full track catalog (one per layout/config), mirroring
   * exchangeCodeForCarCatalog() — merges /track/get with /track/assets (map keyed by
   * track_id) since /track/get's own image fields are unreliable. */
  async exchangeCodeForTrackCatalog(code: string, codeVerifier: string): Promise<IracingTrackData[]> {
    const { accessToken } = await this.exchangeCodeForToken(code, codeVerifier);
    const [tracks, assets] = await Promise.all([
      this.fetchDataApi<IracingTrackData[]>(accessToken, '/track/get'),
      this.fetchDataApi<Record<string, IracingTrackAssetData>>(accessToken, '/track/assets'),
    ]);

    return (tracks ?? []).map((track) => {
      const asset = assets?.[String(track.track_id)];
      return {
        ...track,
        small_image: asset?.small_image ?? null,
        logo: asset?.logo ?? null,
        folder: asset?.folder ?? null,
      };
    });
  }

  /** iRacing's current official series list plus each one's full race-week schedule (track +
   * weather per week) — one /series/season_list call to find the active seasons, then a
   * /series/season_schedule call per season to get its week-by-week details. Not member-
   * specific, same as the car/track catalog syncs (scope "iracing.auth" only). Batches the
   * per-season calls to stay well under iRacing's rate limits — there are usually 60-90 active
   * official seasons at once. */
  async exchangeCodeForSeriesCatalog(code: string, codeVerifier: string): Promise<IracingSeriesSeasonData[]> {
    const { accessToken } = await this.exchangeCodeForToken(code, codeVerifier);
    const [seasonListRaw, assetsRaw] = await Promise.all([
      this.fetchDataApi<unknown>(accessToken, '/series/season_list'),
      this.fetchDataApi<Record<string, { logo?: string }>>(accessToken, '/series/assets'),
    ]);

    /** /series/season_list responds with { seasons: [...] }, unlike /car/get's bare array —
     * confirmed via a live sync. */
    const seasons = extractArray(seasonListRaw, ['seasons', 'series', 'season_list', 'data']);
    const officialSeasons = seasons.filter((season) => season.official !== false);
    const assets = assetsRaw ?? {};

    const results: IracingSeriesSeasonData[] = [];
    const chunkSize = 5;
    for (let i = 0; i < officialSeasons.length; i += chunkSize) {
      const chunk = officialSeasons.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map((season) => this.fetchSeasonSchedule(accessToken, season, assets)),
      );
      results.push(...chunkResults.filter((result): result is IracingSeriesSeasonData => result !== null));
      if (i + chunkSize < officialSeasons.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    return results;
  }

  private async fetchSeasonSchedule(
    accessToken: string,
    season: Record<string, unknown>,
    assets: Record<string, { logo?: string }>,
  ): Promise<IracingSeriesSeasonData | null> {
    const seasonId = season.season_id;
    if (typeof seasonId !== 'number') return null;

    const scheduleResponse = await this.fetchDataApi<unknown>(
      accessToken,
      `/series/season_schedule?season_id=${seasonId}`,
    );
    if (!scheduleResponse) return null;

    const schedule = extractArray(scheduleResponse, ['schedules', 'schedule', 'season_schedule', 'data']);

    /** /series/season_list's season objects don't reliably carry series_name/category —
     * confirmed via a live sync that both only show up on each week's schedule entry (along
     * with season_name, which season_list DOES have, just under a much longer/decorated
     * string). Fall back to season_list's own fields first since they're cheaper to trust, then
     * the first schedule entry. */
    const firstWeek = schedule[0] as Record<string, unknown> | undefined;
    const seriesName =
      (typeof season.series_name === 'string' && season.series_name) ||
      (typeof firstWeek?.series_name === 'string' && firstWeek.series_name) ||
      '';
    const category =
      (typeof season.category === 'string' && season.category) ||
      (typeof firstWeek?.category === 'string' && firstWeek.category) ||
      null;

    const seriesId = Number(season.series_id);

    return {
      seasonId,
      seriesId,
      seriesName,
      seasonName: typeof season.season_name === 'string' ? season.season_name : '',
      category,
      licenseGroup: typeof season.license_group === 'number' ? season.license_group : null,
      official: season.official !== false,
      active: season.active !== false,
      schedule,
      logo: assets[String(seriesId)]?.logo ?? null,
    };
  }

  /** Finds the team(s) the OAuth-authenticated member belongs to (/team/membership — no
   * parameters, scope iracing.auth), then fetches the full roster for the first one via
   * /team/get. Whoever runs "Sync Team Roster" needs to actually be on the team themselves —
   * there's no "look up an arbitrary team_id" flow, matching how this app only ever manages its
   * own single team. */
  async exchangeCodeForTeamRosters(code: string, codeVerifier: string): Promise<IracingTeamRosterResult[]> {
    const { accessToken } = await this.exchangeCodeForToken(code, codeVerifier);

    const membershipRaw = await this.fetchDataApi<unknown>(accessToken, '/team/membership');
    const memberships = extractArray(membershipRaw, ['teams', 'data']);
    const teamIds = memberships.map((m) => Number(m.team_id)).filter((id) => Number.isFinite(id));
    if (teamIds.length === 0) {
      throw new NotFoundException(
        "Your iRacing account isn't a member of any team — sign in with an account that is.",
      );
    }

    const results: IracingTeamRosterResult[] = [];
    for (const teamId of teamIds) {
      const teamRaw = await this.fetchDataApi<Record<string, unknown>>(accessToken, `/team/get?team_id=${teamId}`);
      if (!teamRaw) continue;

      // The roster array from /team/get already carries cust_id + display_name per member (see
      // the Owner shape) — no need for a separate /member/get enrichment call like
      // fetchMemberSnapshots does elsewhere, since all we need to cache is enough to answer "is
      // this cust_id on this roster" later.
      const rosterRaw = extractArray(teamRaw, ['roster']);
      const roster: IracingTeamRosterMemberData[] = rosterRaw
        .map((m) => ({
          custId: Number(m.cust_id),
          displayName: typeof m.display_name === 'string' ? m.display_name : 'Unknown',
        }))
        .filter((m) => Number.isFinite(m.custId));

      results.push({
        teamId,
        teamName: typeof teamRaw.team_name === 'string' ? teamRaw.team_name : 'Unnamed Team',
        ownerCustId: Number(teamRaw.owner_id ?? 0),
        roster,
      });
    }
    return results;
  }

  /** Looks up iRacing members by name (/lookup/drivers) and fetches Sports Car stats for every
   * match in one batch call (/member/get?include_licenses=true) so results can be shown
   * side-by-side (name, location, iRating, SR) — enough to tell same-named drivers apart. Takes
   * an already-valid access token (see IracingDriverLookupService, which owns refreshing the
   * admin's stored token) rather than a code/verifier pair, since this isn't a one-shot
   * OAuth-redirect flow like the catalog syncs — it needs to support repeated searches. */
  async searchDrivers(accessToken: string, searchTerm: string): Promise<IracingLinkResult[]> {
    const lookupRaw = await this.fetchDataApi<unknown>(
      accessToken,
      `/lookup/drivers?search_term=${encodeURIComponent(searchTerm)}`,
    );
    const candidates = extractArray(lookupRaw, ['drivers', 'data']);
    const custIds = candidates
      .map((c) => c.cust_id)
      .filter((id): id is number => typeof id === 'number');
    if (custIds.length === 0) return [];

    const snapshots = await this.fetchMemberSnapshots(accessToken, custIds);
    return custIds.map((id) => snapshots.get(id)).filter((s): s is IracingLinkResult => s !== undefined);
  }

  /** Batch profile snapshot (location, Sports Car iRating/SR) for a list of cust_ids — shared by
   * searchDrivers() and fetchRaceResult() (the latter uses it to enrich/auto-create driver
   * profiles for race participants not yet on our roster). */
  private async fetchMemberSnapshots(accessToken: string, custIds: number[]): Promise<Map<number, IracingLinkResult>> {
    const map = new Map<number, IracingLinkResult>();
    if (custIds.length === 0) return map;

    const memberRaw = await this.fetchDataApi<unknown>(
      accessToken,
      `/member/get?cust_ids=${custIds.join(',')}&include_licenses=true`,
    );
    const members = extractArray(memberRaw, ['members', 'data']);

    for (const member of members) {
      const custId = Number(member.cust_id);
      map.set(custId, {
        name: typeof member.display_name === 'string' ? member.display_name : 'Unknown',
        custId,
        location: extractLocation(member),
        countryCode: extractCountryCode(member),
        sportsCarIrating: extractSportsCarIrating(member),
        sportsCarSafetyRating: extractSportsCarSafetyRating(member),
        refreshToken: null,
      });
    }
    return map;
  }

  /** Pulls one team's result out of a completed session (/results/get?subsession_id=X) — the
   * response covers every team/driver in every session (practice/qualify/race), so this picks
   * the Race session specifically, then the one team entry matching teamId, then that team's
   * per-driver breakdown (driver_results). Positions are 0-indexed in the raw API (confirmed
   * live: a P6 finish came back as 5) — toRacePosition() converts to the 1-indexed value
   * iRacing's own site displays. Lap times are converted from iRacing's 1/10,000-second units
   * to milliseconds, with the -1 "no time set" sentinel mapped to null. Also fetches the full
   * lap-by-lap breakdown (/results/lap_data) for every driver on the team, including which laps
   * had a pit stop — see IracingLapData. */
  async fetchRaceResult(accessToken: string, subsessionId: number, teamId: number): Promise<IracingRaceResultData> {
    const raw = await this.fetchDataApi<Record<string, unknown>>(
      accessToken,
      `/results/get?subsession_id=${subsessionId}`,
    );
    if (!raw) {
      throw new NotFoundException('Could not fetch that session from iRacing — check the session ID.');
    }

    const sessionResultsArr = extractArray(raw, ['session_results']);

    // Confirmed live: simsession_name comes back fully uppercase ("PRACTICE"/"QUALIFY"/"RACE"),
    // not the "Race" capitalization used elsewhere on iRacing's site — match case-insensitively
    // rather than relying on session ordering (multi-race/heat formats may not put Race last).
    const raceSession =
      sessionResultsArr.find((s) => typeof s.simsession_name === 'string' && s.simsession_name.toUpperCase() === 'RACE') ??
      sessionResultsArr[sessionResultsArr.length - 1];
    if (!raceSession) {
      throw new NotFoundException('No race session found for that session ID.');
    }

    const results = extractArray(raceSession, ['results']);

    // iRacing represents team entries with a *negative* team_id (teams share the cust_id
    // namespace with real members, distinguished by sign) — confirmed live: a team whose
    // website/URL id is 287336 came back as team_id: -287336. Comparing by absolute value lets
    // an admin enter the id exactly as shown on iRacing's own site, sign and all.
    const teamResult = results.find((r) => Math.abs(Number(r.team_id)) === Math.abs(teamId));
    if (!teamResult) {
      throw new NotFoundException('No result found for that team in this session.');
    }

    const track = raw.track as Record<string, unknown> | undefined;
    const raceSummary = raw.race_summary as Record<string, unknown> | undefined;
    const driverResults = extractArray(teamResult, ['driver_results']);

    const sessionSplits = extractArray(raw, ['session_splits']);
    const splitIndex = sessionSplits.findIndex((split) => Number(split.subsession_id) === subsessionId);
    const splitNumber = splitIndex >= 0 ? splitIndex + 1 : null;
    const totalSplits = sessionSplits.length > 0 ? sessionSplits.length : null;

    const driverCustIds = driverResults
      .map((d) => Number(d.cust_id))
      .filter((id) => Number.isFinite(id));
    const snapshots = await this.fetchMemberSnapshots(accessToken, driverCustIds);

    // team_id here is iRacing's own signed value from the response (see the sign-comparison
    // note above) — reused as-is for lap_data rather than re-deriving from the caller's teamId.
    const rawTeamId = typeof teamResult.team_id === 'number' ? teamResult.team_id : null;
    const simsessionNumber = typeof raceSession.simsession_number === 'number' ? raceSession.simsession_number : null;

    if (rawTeamId === null || simsessionNumber === null) {
      this.logger.warn(
        `Skipping lap_data fetch — rawTeamId=${JSON.stringify(teamResult.team_id)}, ` +
          `simsession_number=${JSON.stringify(raceSession.simsession_number)} (expected numbers)`,
      );
    }

    const laps =
      rawTeamId !== null && simsessionNumber !== null
        ? await this.fetchLapData(accessToken, subsessionId, simsessionNumber, rawTeamId)
        : [];

    return {
      subsessionId,
      teamId,
      seriesName: typeof raw.series_name === 'string' ? raw.series_name : null,
      trackName: typeof track?.track_name === 'string' ? track.track_name : 'Unknown track',
      trackConfig: typeof track?.config_name === 'string' ? track.config_name : null,
      trackId: toNullableInt(track?.track_id),
      carName: typeof teamResult.car_name === 'string' ? teamResult.car_name : null,
      carClassName: typeof teamResult.car_class_name === 'string' ? teamResult.car_class_name : null,
      carId: toNullableInt(teamResult.car_id),
      startTime: typeof raw.start_time === 'string' ? raw.start_time : null,
      endTime: typeof raw.end_time === 'string' ? raw.end_time : null,
      startingPosition: toRacePosition(teamResult.starting_position),
      finishingPosition: toRacePosition(teamResult.finish_position),
      startingPositionInClass: toRacePosition(teamResult.starting_position_in_class),
      finishingPositionInClass: toRacePosition(teamResult.finish_position_in_class),
      teamLapsComplete: toNullableInt(teamResult.laps_complete),
      totalLaps: toNullableInt(raceSummary?.laps_complete),
      teamIncidents: toNullableInt(teamResult.incidents),
      splitNumber,
      totalSplits,
      drivers: driverResults.map((d) => {
        const custId = Number(d.cust_id);
        const snapshot = snapshots.get(custId);
        return {
          custId,
          displayName: typeof d.display_name === 'string' ? d.display_name : (snapshot?.name ?? 'Unknown'),
          startingPosition: toRacePosition(d.starting_position),
          finishingPosition: toRacePosition(d.finish_position),
          averageLapTimeMs: toMillis(d.average_lap),
          bestLapTimeMs: toMillis(d.best_lap_time),
          incidents: toNullableInt(d.incidents),
          lapsComplete: toNullableInt(d.laps_complete),
          location: snapshot?.location ?? null,
          countryCode: snapshot?.countryCode ?? null,
          sportsCarIrating: snapshot?.sportsCarIrating ?? null,
          sportsCarSafetyRating: snapshot?.sportsCarSafetyRating ?? null,
        };
      }),
      laps,
    };
  }

  /** Every official *race* subsession (event_types=5 — confirmed live: leaving this off also
   * pulls back standalone practice/qualify subsessions with no RACE simsession in them at all,
   * which fetchCarUsageForSubsession's "find RACE, else fall back to whatever's there" logic was
   * then silently mis-reading as a tiny field) for one series' race week whose start time falls in
   * the given window — powers IracingCarUsageSyncService's hourly car-usage scan. Mirrors the
   * community iracingdataapi Python client's result_search_series() (this endpoint's shape isn't
   * in iRacing's own public docs): /data/results/search_series, chunked like every high-volume
   * Data API endpoint, but — confirmed against that client's source, not a live call from here —
   * with the chunk_info nested one level deeper (`data.chunk_info`) than /results/lap_data's
   * top-level one. Checks both locations defensively in case that turns out to be wrong. */
  async searchSeriesResults(
    accessToken: string,
    seriesId: number,
    raceWeekNum: number,
    startRangeBegin: Date,
    startRangeEnd: Date,
  ): Promise<number[]> {
    const params = new URLSearchParams({
      series_id: String(seriesId),
      race_week_num: String(raceWeekNum),
      start_range_begin: startRangeBegin.toISOString(),
      start_range_end: startRangeEnd.toISOString(),
      official_only: 'true',
      event_types: '5', // Race only — see doc comment above
    });
    const raw = await this.fetchDataApi<{ data?: { chunk_info?: unknown } } & { chunk_info?: unknown }>(
      accessToken,
      `/results/search_series?${params.toString()}`,
    );
    if (!raw) return [];

    const chunkInfo = raw.data?.chunk_info ?? raw.chunk_info;
    const rows = await this.fetchChunkedRows(chunkInfo);
    return rows.map((r) => toNullableInt(r.subsession_id)).filter((id): id is number => id !== null);
  }

  /** Which car every entry (one per team/driver, not deduplicated) raced in a session's Race — one
   * /results/get?subsession_id=X call, same as fetchRaceResult(), but returns every entry's car
   * instead of filtering down to one team's, for tallying series-wide car usage rather than
   * importing a single result.
   *
   * Unlike fetchRaceResult()'s RACE-session lookup, this requires an *exact* simsession_name match
   * and returns nothing at all otherwise — no "fall back to the last session" heuristic. That
   * fallback is fine for fetchRaceResult (an admin importing a specific result they know they
   * raced), but here it silently mis-tallied a subsession's PRACTICE field as if it were the race
   * — confirmed live: searchSeriesResults() without an event_types filter returned standalone
   * practice/qualify subsessions with no RACE simsession in them at all. event_types=5 there
   * should prevent this from happening in the first place; this is the second, independent guard
   * so a mismatch never gets counted instead of just skipped. */
  async fetchCarUsageForSubsession(
    accessToken: string,
    subsessionId: number,
  ): Promise<{ carId: number; carName: string; carClass: string }[]> {
    const raw = await this.fetchDataApi<Record<string, unknown>>(
      accessToken,
      `/results/get?subsession_id=${subsessionId}`,
    );
    if (!raw) return [];

    const sessionResultsArr = extractArray(raw, ['session_results']);
    const raceSession = sessionResultsArr.find(
      (s) => typeof s.simsession_name === 'string' && s.simsession_name.toUpperCase() === 'RACE',
    );
    if (!raceSession) {
      this.logger.warn(`Subsession ${subsessionId} has no RACE simsession — skipping (not counted as car usage)`);
      return [];
    }

    const results = extractArray(raceSession, ['results']);
    return results
      .map((r) => ({
        carId: toNullableInt(r.car_id),
        carName: typeof r.car_name === 'string' ? r.car_name : null,
        // Same field fetchRaceResult() already reads as car_class_name (e.g. "GT3 Class") — real
        // per-entry class from this series' own results, not iRacing's global car catalog category
        // (IracingCar.categories), which doesn't distinguish e.g. GT3 vs GT4 within a mixed series.
        carClass: normalizeCarClassName(typeof r.car_class_name === 'string' ? r.car_class_name : null),
      }))
      .filter(
        (r): r is { carId: number; carName: string; carClass: string } => r.carId !== null && r.carName !== null,
      );
  }

  /** One team's full lap-by-lap history across every driver who drove it — used to reconstruct
   * stints client-side by detecting driver changes (see lib/stints.ts on the frontend), rather
   * than trying to spot a pit stop from `lap_events` — that field's vocabulary turned out to be
   * generic incident/flag text ("car contact", "off track", "invalid", ...), not a clean pit
   * marker, confirmed against a live sample.
   *
   * Unlike every other Data API call in this file, this endpoint doesn't respond with the lap
   * array itself (even after following the usual {link} S3 indirection) — confirmed live, the
   * resolved payload is session metadata plus a `chunk_info` object describing a *second* level
   * of indirection: a base URL + a list of chunk file names, each holding a slice of the lap
   * array, that must be fetched and concatenated. */
  private async fetchLapData(
    accessToken: string,
    subsessionId: number,
    simsessionNumber: number,
    teamId: number,
  ): Promise<IracingLapData[]> {
    const path = `/results/lap_data?subsession_id=${subsessionId}&simsession_number=${simsessionNumber}&team_id=${teamId}`;
    const raw = await this.fetchDataApi<Record<string, unknown>>(accessToken, path);
    if (!raw) return [];

    const laps = await this.fetchChunkedRows(raw.chunk_info);

    return laps.map((l) => ({
      custId: Number(l.cust_id),
      displayName: typeof l.display_name === 'string' ? l.display_name : 'Unknown',
      lapNumber: typeof l.lap_number === 'number' ? l.lap_number : 0,
      lapTimeMs: toMillis(l.lap_time),
      incident: l.incident === true,
      sessionTime: typeof l.session_time === 'number' ? l.session_time : 0,
    }));
  }

  /** Fetches and concatenates every chunk file described by a Data API `chunk_info` object
   * (base_download_url + chunk_file_names) — the "chunked" response pattern used by high-volume
   * endpoints like /results/lap_data. Each chunk file is plain unauthenticated JSON, same as the
   * S3 links used elsewhere. */
  private async fetchChunkedRows(chunkInfo: unknown): Promise<Record<string, unknown>[]> {
    if (!chunkInfo || typeof chunkInfo !== 'object') return [];
    const info = chunkInfo as Record<string, unknown>;
    const baseUrl = info.base_download_url;
    const fileNames = info.chunk_file_names;
    if (typeof baseUrl !== 'string' || !Array.isArray(fileNames)) return [];

    const chunks = await Promise.all(
      fileNames.map(async (fileName) => {
        if (typeof fileName !== 'string') return [];
        const response = await fetch(`${baseUrl}${fileName}`);
        if (!response.ok) {
          this.logger.warn(`iRacing chunk fetch failed: ${baseUrl}${fileName} -> ${response.status}`);
          return [];
        }
        const json = (await response.json()) as unknown;
        return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
      }),
    );

    return chunks.flat();
  }

  private async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string; refreshToken: string | null }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.configService.getOrThrow<string>('IRACING_CLIENT_ID'),
      code,
      redirect_uri: this.configService.getOrThrow<string>('IRACING_REDIRECT_URI'),
      code_verifier: codeVerifier,
    });

    const response = await fetch(`${IRACING_OAUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(`iRacing token exchange failed: ${response.status} ${text}`);
      throw new BadGatewayException('Failed to exchange the iRacing authorization code');
    }

    const json = (await response.json()) as IracingTokenResponse;
    return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null };
  }

  /** iRacing refresh tokens are single-use — each successful refresh returns a new one, which
   * the caller must persist in place of the old one. Returns null if the refresh token was
   * rejected (revoked or expired from inactivity). Public: also used by
   * IracingDriverLookupService to power admin-driven driver search on demand, reusing the
   * admin's own stored refresh token instead of a fresh OAuth round-trip per search. */
  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string | null } | null> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.configService.getOrThrow<string>('IRACING_CLIENT_ID'),
      refresh_token: refreshToken,
    });

    const response = await fetch(`${IRACING_OAUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(`iRacing token refresh failed: ${response.status} ${text}`);
      return null;
    }

    const json = (await response.json()) as IracingTokenResponse;
    return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null };
  }

  private async fetchIdentity(accessToken: string): Promise<IracingIdentity> {
    const response = await fetch(`${IRACING_OAUTH_BASE}/iracing/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(`iRacing profile fetch failed: ${response.status} ${text}`);
      throw new BadGatewayException('Failed to fetch the iRacing profile');
    }

    return response.json() as Promise<IracingIdentity>;
  }

  /** Most of the Data API's endpoints (per https://json.racing/irdata-schema) respond with
   * `{ link: "https://...s3..." }` rather than the payload directly — this fetches that link
   * (unauthenticated, presigned) automatically. Tolerates endpoints that return the payload
   * directly too, in case behavior varies. */
  private async fetchDataApi<T>(accessToken: string, path: string): Promise<T | null> {
    const response = await fetch(`${IRACING_DATA_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(`iRacing Data API ${path} fetch failed: ${response.status} ${text}`);
      return null;
    }

    const body = (await response.json()) as { link?: string } & Record<string, unknown>;

    if (typeof body.link !== 'string') {
      return body as T;
    }

    const linkResponse = await fetch(body.link);
    if (!linkResponse.ok) {
      this.logger.warn(`iRacing Data API ${path} S3 link fetch failed: ${linkResponse.status}`);
      return null;
    }

    return linkResponse.json() as Promise<T>;
  }
}

/** iRacing's car_class_name comes back like "GT3 Class" — strips the redundant " Class" suffix so
 * it reads as a plain class label ("GT3"). Same normalization race-results.service.ts applies to
 * the same field on a different endpoint; duplicated rather than shared since Events and Iracing
 * are deliberately decoupled modules. "Unknown" (rather than null) so callers can always key/group
 * by this without a null-check. */
function normalizeCarClassName(carClassName: string | null): string {
  if (!carClassName) return 'Unknown';
  const stripped = carClassName.replace(/\s+class$/i, '').trim();
  return stripped || carClassName;
}

/** Passes numeric fields through as-is, mapping iRacing's -1 "not set" sentinel (and anything
 * else non-numeric) to null rather than storing a nonsensical negative value. */
function toNullableInt(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 ? value : null;
}

/** iRacing lap times (average_lap, best_lap_time) are in units of 1/10,000 of a second —
 * converted here to milliseconds. -1 means no time was set. */
function toMillis(value: unknown): number | null {
  if (typeof value !== 'number' || value < 0) return null;
  return Math.round(value / 10);
}

/** starting_position/finish_position come back 0-indexed (P1 = 0) — confirmed live: an actual
 * P6 finish was returned as 5. +1 to match the 1-indexed position iRacing's own site shows. */
function toRacePosition(value: unknown): number | null {
  if (typeof value !== 'number' || value < 0) return null;
  return value + 1;
}

/** Standard ISO 3166-1 alpha-3 → alpha-2 mapping — see extractCountryCode(). */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  AFG: 'AF', ALA: 'AX', ALB: 'AL', DZA: 'DZ', ASM: 'AS', AND: 'AD', AGO: 'AO', AIA: 'AI',
  ATA: 'AQ', ATG: 'AG', ARG: 'AR', ARM: 'AM', ABW: 'AW', AUS: 'AU', AUT: 'AT', AZE: 'AZ',
  BHS: 'BS', BHR: 'BH', BGD: 'BD', BRB: 'BB', BLR: 'BY', BEL: 'BE', BLZ: 'BZ', BEN: 'BJ',
  BMU: 'BM', BTN: 'BT', BOL: 'BO', BES: 'BQ', BIH: 'BA', BWA: 'BW', BVT: 'BV', BRA: 'BR',
  IOT: 'IO', BRN: 'BN', BGR: 'BG', BFA: 'BF', BDI: 'BI', CPV: 'CV', KHM: 'KH', CMR: 'CM',
  CAN: 'CA', CYM: 'KY', CAF: 'CF', TCD: 'TD', CHL: 'CL', CHN: 'CN', CXR: 'CX', CCK: 'CC',
  COL: 'CO', COM: 'KM', COG: 'CG', COD: 'CD', COK: 'CK', CRI: 'CR', CIV: 'CI', HRV: 'HR',
  CUB: 'CU', CUW: 'CW', CYP: 'CY', CZE: 'CZ', DNK: 'DK', DJI: 'DJ', DMA: 'DM', DOM: 'DO',
  ECU: 'EC', EGY: 'EG', SLV: 'SV', GNQ: 'GQ', ERI: 'ER', EST: 'EE', SWZ: 'SZ', ETH: 'ET',
  FLK: 'FK', FRO: 'FO', FJI: 'FJ', FIN: 'FI', FRA: 'FR', GUF: 'GF', PYF: 'PF', ATF: 'TF',
  GAB: 'GA', GMB: 'GM', GEO: 'GE', DEU: 'DE', GHA: 'GH', GIB: 'GI', GRC: 'GR', GRL: 'GL',
  GRD: 'GD', GLP: 'GP', GUM: 'GU', GTM: 'GT', GGY: 'GG', GIN: 'GN', GNB: 'GW', GUY: 'GY',
  HTI: 'HT', HMD: 'HM', VAT: 'VA', HND: 'HN', HKG: 'HK', HUN: 'HU', ISL: 'IS', IND: 'IN',
  IDN: 'ID', IRN: 'IR', IRQ: 'IQ', IRL: 'IE', IMN: 'IM', ISR: 'IL', ITA: 'IT', JAM: 'JM',
  JPN: 'JP', JEY: 'JE', JOR: 'JO', KAZ: 'KZ', KEN: 'KE', KIR: 'KI', PRK: 'KP', KOR: 'KR',
  KWT: 'KW', KGZ: 'KG', LAO: 'LA', LVA: 'LV', LBN: 'LB', LSO: 'LS', LBR: 'LR', LBY: 'LY',
  LIE: 'LI', LTU: 'LT', LUX: 'LU', MAC: 'MO', MDG: 'MG', MWI: 'MW', MYS: 'MY', MDV: 'MV',
  MLI: 'ML', MLT: 'MT', MHL: 'MH', MTQ: 'MQ', MRT: 'MR', MUS: 'MU', MYT: 'YT', MEX: 'MX',
  FSM: 'FM', MDA: 'MD', MCO: 'MC', MNG: 'MN', MNE: 'ME', MSR: 'MS', MAR: 'MA', MOZ: 'MZ',
  MMR: 'MM', NAM: 'NA', NRU: 'NR', NPL: 'NP', NLD: 'NL', NCL: 'NC', NZL: 'NZ', NIC: 'NI',
  NER: 'NE', NGA: 'NG', NIU: 'NU', NFK: 'NF', MKD: 'MK', MNP: 'MP', NOR: 'NO', OMN: 'OM',
  PAK: 'PK', PLW: 'PW', PSE: 'PS', PAN: 'PA', PNG: 'PG', PRY: 'PY', PER: 'PE', PHL: 'PH',
  PCN: 'PN', POL: 'PL', PRT: 'PT', PRI: 'PR', QAT: 'QA', REU: 'RE', ROU: 'RO', RUS: 'RU',
  RWA: 'RW', BLM: 'BL', SHN: 'SH', KNA: 'KN', LCA: 'LC', MAF: 'MF', SPM: 'PM', VCT: 'VC',
  WSM: 'WS', SMR: 'SM', STP: 'ST', SAU: 'SA', SEN: 'SN', SRB: 'RS', SYC: 'SC', SLE: 'SL',
  SGP: 'SG', SXM: 'SX', SVK: 'SK', SVN: 'SI', SLB: 'SB', SOM: 'SO', ZAF: 'ZA', SGS: 'GS',
  SSD: 'SS', ESP: 'ES', LKA: 'LK', SDN: 'SD', SUR: 'SR', SJM: 'SJ', SWE: 'SE', CHE: 'CH',
  SYR: 'SY', TWN: 'TW', TJK: 'TJ', TZA: 'TZ', THA: 'TH', TLS: 'TL', TGO: 'TG', TKL: 'TK',
  TON: 'TO', TTO: 'TT', TUN: 'TN', TUR: 'TR', TKM: 'TM', TCA: 'TC', TUV: 'TV', UGA: 'UG',
  UKR: 'UA', ARE: 'AE', GBR: 'GB', USA: 'US', UMI: 'UM', URY: 'UY', UZB: 'UZ', VUT: 'VU',
  VEN: 'VE', VNM: 'VN', VGB: 'VG', VIR: 'VI', WLF: 'WF', ESH: 'EH', YEM: 'YE', ZMB: 'ZM',
  ZWE: 'ZW',
};

/** "flair_name" is iRacing's member-selected country flag, e.g. "Germany" — the closest thing
 * to nationality this API exposes. Falls back to the ISO code if the full name isn't present. */
function extractLocation(memberInfo: Record<string, unknown> | null): string | null {
  if (!memberInfo) return null;
  const candidate = memberInfo.flair_name ?? memberInfo.flair_shortname ?? memberInfo.flair_country_code;
  return typeof candidate === 'string' ? candidate : null;
}

/** ISO 3166-1 alpha-2 code, e.g. "DE" for Germany — used to render a nationality flag on the
 * frontend (see lib/flag.ts), separate from extractLocation()'s human-readable name.
 * /member/info has `flair_country_code` (alpha-2) directly, but /member/get — used for driver
 * search, see searchDrivers() — doesn't include it at all, only `flair_shortname` (alpha-3, e.g.
 * "AUT"); confirmed via a live response. Falls back to converting that through the standard
 * ISO 3166-1 table below. */
function extractCountryCode(memberInfo: Record<string, unknown> | null): string | null {
  if (!memberInfo) return null;

  const direct = memberInfo.flair_country_code;
  if (typeof direct === 'string' && direct.length === 2) return direct.toUpperCase();

  const alpha3 = memberInfo.flair_shortname;
  if (typeof alpha3 === 'string') {
    const alpha2 = ALPHA3_TO_ALPHA2[alpha3.toUpperCase()];
    if (alpha2) return alpha2;
  }

  return null;
}

/** `licenses` is shaped differently depending on the endpoint — /member/info returns an object
 * keyed by category slug (`licenses.sports_car`), while /member/get returns an array of license
 * objects each with their own `category` field; confirmed both shapes from live responses. */
function findSportsCarLicense(memberInfo: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!memberInfo || !memberInfo.licenses) return null;
  const licenses = memberInfo.licenses;

  if (Array.isArray(licenses)) {
    const match = licenses.find(
      (entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).category === 'sports_car',
    );
    return match ? (match as Record<string, unknown>) : null;
  }

  if (typeof licenses === 'object') {
    const sportsCar = (licenses as Record<string, unknown>).sports_car;
    return sportsCar && typeof sportsCar === 'object' ? (sportsCar as Record<string, unknown>) : null;
  }

  return null;
}

function extractSportsCarIrating(memberInfo: Record<string, unknown> | null): number | null {
  const irating = findSportsCarLicense(memberInfo)?.irating;
  return typeof irating === 'number' ? irating : null;
}

/** e.g. "A 4.10" — license class letter (from "Class A") + safety rating to 2 decimals, the
 * same compact format iRacing itself displays. */
function extractSportsCarSafetyRating(memberInfo: Record<string, unknown> | null): string | null {
  const license = findSportsCarLicense(memberInfo);
  if (!license) return null;

  const groupName = typeof license.group_name === 'string' ? license.group_name : null;
  const classLetter = groupName?.replace(/^Class\s+/i, '') ?? null;
  const safetyRating = typeof license.safety_rating === 'number' ? license.safety_rating.toFixed(2) : null;

  if (classLetter && safetyRating) return `${classLetter} ${safetyRating}`;
  return classLetter ?? safetyRating;
}
