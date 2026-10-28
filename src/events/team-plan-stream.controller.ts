import { Controller, NotFoundException, Param, ParseUUIDPipe, Sse, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { merge, type Observable } from 'rxjs';
import { Repository } from 'typeorm';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { User } from '../users/user.entity.js';
import { EventTeam } from './event-team.entity.js';
import { Event } from './event.entity.js';
import { TeamPlanEventsService, type TeamPlanMessageEvent } from './team-plan-events.service.js';
import { TeamPlanPresenceService } from './team-plan-presence.service.js';

/** Live "the plan changed" feed for the team stint-plan page (Server-Sent Events). Carries only a
 * small change notice; clients refetch the actual data through the normal REST endpoints. */
@Controller('events/:eventId/teams/:teamId/stream')
@UseGuards(JwtAuthGuard)
export class TeamPlanStreamController {
  constructor(
    private readonly planEvents: TeamPlanEventsService,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    private readonly presence: TeamPlanPresenceService,
  ) {}

  /** Same visibility as the other team GETs plus the event rule from EventsService.findByIdForViewer:
   * the team must belong to the event, and a DRAFT event is hidden from non-admins. Checked once at
   * connect time — a failure here is an ordinary 404 (headers aren't committed yet). */
  @Sse()
  async stream(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: User,
  ): Promise<Observable<TeamPlanMessageEvent>> {
    const event = await this.eventsRepository.findOne({ where: { id: eventId }, select: { id: true, status: true } });
    if (!event || (user.role !== Role.ADMIN && event.status === EventStatus.DRAFT)) {
      throw new NotFoundException('Event not found');
    }
    const team = await this.teamsRepository.findOne({ where: { id: teamId, eventId }, select: { id: true } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    // Change notices + heartbeat, merged with the named `presence` event. Closing the connection
    // unsubscribes both, which also unregisters the viewer.
    return merge(
      this.planEvents.sse(eventId, teamId),
      this.presence.connect(eventId, teamId, { userId: user.id, isAdmin: user.role === Role.ADMIN }),
    );
  }
}
