import { IsString } from 'class-validator';
import { IsStrongUserPassword } from '../../../common/validation/strong-password.decorator';

export class ResetUserPasswordDto {
  @IsString()
  @IsStrongUserPassword()
  password!: string;
}
