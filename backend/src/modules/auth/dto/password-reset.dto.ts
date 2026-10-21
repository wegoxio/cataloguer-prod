import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';
import { IsStrongUserPassword } from '../../../common/validation/strong-password.decorator';

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @IsStrongUserPassword()
  newPassword!: string;

  // Sent as true by the welcome (invitation) flow's Terms checkbox
  @IsOptional()
  @IsBoolean()
  acceptTerms?: boolean;
}
