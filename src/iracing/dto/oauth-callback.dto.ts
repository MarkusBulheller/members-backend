import { IsString } from 'class-validator';

/** The payload the frontend hands us after completing iRacing's PKCE redirect — used for both
 * the account-link flow and the car-catalog sync flow, which share the same OAuth mechanics. */
export class OAuthCallbackDto {
  @IsString()
  code: string;

  @IsString()
  codeVerifier: string;
}
