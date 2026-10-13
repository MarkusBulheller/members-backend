import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { EventStatus } from '../../common/enums/event-status.enum.js';
import { Sim } from '../../common/enums/sim.enum.js';

export class CreateEventDto {
  /** Omitted = IRACING (the column default on create, unchanged on update). */
  @IsOptional()
  @IsEnum(Sim)
  sim?: Sim;

  /** iRacing fuel-fill limit, as a percent of the car's max tank (1-100). Null clears it. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(1)
  @Max(100)
  fuelLimitPercent?: number | null;

  @IsString()
  @MaxLength(150)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsUUID()
  trackId: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  carClasses: string[];

  @IsDateString()
  startsAt: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsDateString()
  signupDeadline?: string;

  /** Minutes — a fixed preset list (mirrored on the frontend, see types/raceLength.ts):
   * 2h40m / 3h / 4h / 6h / 8h / 10h / 12h / 24h. */
  @IsIn([160, 180, 240, 360, 480, 600, 720, 1440])
  raceLengthMinutes: number;

  /** Candidate start times (ISO datetimes) — see EventTimeslot. Replaces the whole set on
   * update (see EventsService.update()'s diffing). */
  @IsArray()
  @ArrayMinSize(1)
  @IsDateString({}, { each: true })
  timeslots: string[];

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  /** Links this event to a specific iRacing series-season week — undefined leaves the link
   * unchanged (update) / unset (create), null clears it, a number sets it. Both fields are set or
   * cleared together by the client (see event.entity.ts); not cross-validated here. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  iracingSeasonId?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  iracingRaceWeekNum?: number | null;
}
