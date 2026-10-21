import { IsIn } from 'class-validator';
import { ASSIGNABLE_ROLES } from './create-user.dto';

export class UpdateUserRoleDto {
  @IsIn(ASSIGNABLE_ROLES)
  role!: string;
}
