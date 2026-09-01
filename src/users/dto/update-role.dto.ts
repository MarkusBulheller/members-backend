import { IsEnum } from 'class-validator';
import { Role } from '../../common/enums/role.enum.js';

export class UpdateRoleDto {
  @IsEnum(Role)
  role: Role;
}
