import { IsOptional, IsString, IsEmail, MaxLength } from 'class-validator';

export class CreateUpdateSettingsDto {
  @IsString()
  @IsOptional()
  companyName?: string;

  @IsEmail()
  @IsOptional()
  companyEmail?: string;

  @IsString()
  @IsOptional()
  companyPhone?: string;

  @IsString()
  @IsOptional()
  companyAddress?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  currency?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  timezone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  announcementTitle?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  announcementBody?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  announcementUrl?: string;
}
