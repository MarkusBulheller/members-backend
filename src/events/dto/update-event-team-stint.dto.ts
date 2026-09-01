import { PartialType } from '@nestjs/mapped-types';
import { CreateEventTeamStintDto } from './create-event-team-stint.dto.js';

export class UpdateEventTeamStintDto extends PartialType(CreateEventTeamStintDto) {}
