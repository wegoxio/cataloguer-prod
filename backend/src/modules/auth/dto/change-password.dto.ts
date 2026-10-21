import { IsString } from 'class-validator';
import { IsStrongUserPassword } from '../../../common/validation/strong-password.decorator';

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @IsStrongUserPassword()
  newPassword!: string;
}
