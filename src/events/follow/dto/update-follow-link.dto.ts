import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { FOLLOW_NAMES_MODES, type FollowNamesMode } from '../follow-names.js';

export class UpdateFollowLinkDto {
  /** true = turn the link on (mints a token if there is none); false = revoke it. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(FOLLOW_NAMES_MODES)
  namesMode?: FollowNamesMode;

  /** true = replace the token; the old link stops working immediately. */
  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}
