import { PartialType } from '@nestjs/mapped-types';
import { CreateAchievementDefinitionDto } from './create-achievement-definition.dto.js';

export class UpdateAchievementDefinitionDto extends PartialType(CreateAchievementDefinitionDto) {}
