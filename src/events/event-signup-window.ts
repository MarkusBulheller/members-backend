import { EventStatus } from '../common/enums/event-status.enum.js';

/** Whether new signups are still being accepted for an event: it must be PUBLISHED and, if the
 * admin set a signup deadline, that deadline must not have passed. Used by the Discord post (to
 * decide whether to show the Sign up buttons) and the Discord interaction flow. */
export function isEventOpenForSignups(
  event: { status: EventStatus; signupDeadline: Date | null },
  now: Date = new Date(),
): boolean {
  if (event.status !== EventStatus.PUBLISHED) return false;
  return !event.signupDeadline || event.signupDeadline.getTime() > now.getTime();
}
