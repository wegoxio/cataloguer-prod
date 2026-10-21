import { IsIn, IsOptional, IsString, IsInt, IsBoolean } from 'class-validator';

export class UpdateProductImageDto {
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
