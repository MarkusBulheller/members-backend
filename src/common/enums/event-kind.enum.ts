/** What sort of event this is. A SPECIAL event is a one-off (a 24h race, a championship round) with
 * its own sign-up post in the events channel; a WEEKLY series race recurs every week and has its sign-up
 * posts in a channel of its own, so it doesn't bury the special events. */
export enum EventKind {
  SPECIAL = 'SPECIAL',
  WEEKLY = 'WEEKLY',
}
