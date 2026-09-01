import { PartialType } from '@nestjs/mapped-types';
import { CreateEventTeamDto } from './create-event-team.dto.js';

export class UpdateEventTeamDto extends PartialType(CreateEventTeamDto) {}
