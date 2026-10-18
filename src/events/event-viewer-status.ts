import { EventStatus } from '../common/enums/event-status.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';

/** The requesting user's own relationship to an event — returned as `viewer` on GET /events and
 * GET /events/:id. Mirrors `EventViewerStatus` in the portal's types/event.ts. */
export interface EventViewerStatus {
  /** Has a non-cancelled signup. */
  signedUp: boolean;
  /** Is placed on one of the event's teams (and the signup is still active). */
  onTeam: boolean;
  /** The event is COMPLETED and the user was placed on a team for it. */
  raced: boolean;
}

/** The slice of an EventSignup this needs — kept structural so tests don't need a full entity. */
export interface ViewerSignupLike {
  eventId: string;
  status: SignupStatus;
  eventTeamId: string | null;
}

export const NO_VIEWER_STATUS: EventViewerStatus = { signedUp: false, onTeam: false, raced: false };

export function computeViewerStatus(eventStatus: EventStatus, signup: ViewerSignupLike | undefined): EventViewerStatus {
  if (!signup || signup.status === SignupStatus.CANCELLED) return { ...NO_VIEWER_STATUS };
  const onTeam = signup.eventTeamId !== null && signup.eventTeamId !== undefined;
  return { signedUp: true, onTeam, raced: onTeam && eventStatus === EventStatus.COMPLETED };
}

/** Attaches `viewer` to each event from the viewer's signups (one per event at most — there's a
 * unique index on eventId+userId), so the list endpoint needs just one signups query. */
export function withViewerStatus<T extends { id: string; status: EventStatus }>(
  events: T[],
  viewerSignups: ViewerSignupLike[],
): (T & { viewer: EventViewerStatus })[] {
  const byEvent = new Map(viewerSignups.map((s) => [s.eventId, s]));
  return events.map((event) => ({ ...event, viewer: computeViewerStatus(event.status, byEvent.get(event.id)) }));
}
