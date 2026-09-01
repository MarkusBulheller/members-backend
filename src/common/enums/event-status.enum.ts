export enum EventStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  /** Signups are closed but the event hasn't run yet — the team-building phase, where an admin
   * reviews everyone who signed up and splits them into EventTeams. Reachable only from
   * PUBLISHED (see EventDetailPage's "Close Signups" button); an admin can also revert to
   * PUBLISHED to reopen signups. */
  SIGNUPS_CLOSED = 'SIGNUPS_CLOSED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}
