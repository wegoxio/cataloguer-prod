import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const ASSIGNABLE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER'] as const;

export class CreateUserDto {
  @IsEmail()
  email!: string;

  // Optional for store-bound admins: their invites inherit their company
  @IsOptional()
  @IsString()
  @MaxLength(120)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsIn(ASSIGNABLE_ROLES)
  role!: string;
}
