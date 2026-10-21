import { IsIn, IsNotEmpty, IsOptional, IsString, IsInt, IsBoolean, IsUrl } from 'class-validator';

export class CreateProductImageDto {
  // Shape check only — the storage allow policy (#174) decides whether the
  // URL is actually acceptable, with tenant context the DTO cannot have
  @IsUrl({}, { message: 'URL must be a valid URL' })
  @IsNotEmpty()
  url!: string;

  @IsString()
  @IsOptional()
  altText?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;

  @IsIn(['CONTAIN', 'COVER'])
  @IsOptional()
  displayMode?: string;
}
