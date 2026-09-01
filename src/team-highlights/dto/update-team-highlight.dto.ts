import { PartialType } from '@nestjs/mapped-types';
import { CreateTeamHighlightDto } from './create-team-highlight.dto.js';

export class UpdateTeamHighlightDto extends PartialType(CreateTeamHighlightDto) {}
