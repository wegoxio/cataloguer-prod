import { ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { CATALOGUE_PLACEMENTS, CataloguePlacement } from '../entities/store-category-publication.entity';
import { CATALOGUE_GROUP_PURPOSES, CatalogueGroupPurpose } from '../entities/catalogue-group.entity';

export class CreateChannelDto {
  @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(80) key!: string;
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @IsOptional() description?: string;
  @IsBoolean() @IsOptional() isDefault?: boolean;
  @IsBoolean() @IsOptional() active?: boolean;
  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
}

export class UpdateChannelDto {
  @IsString() @IsNotEmpty() @MaxLength(160) @IsOptional() name?: string;
  @IsString() @IsOptional() description?: string;
  @IsBoolean() @IsOptional() isDefault?: boolean;
  @IsBoolean() @IsOptional() active?: boolean;
  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
}

export class CreateGroupDto {
  @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(80) key!: string;
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @IsOptional() description?: string;
  @IsIn(CATALOGUE_GROUP_PURPOSES) @IsOptional() purpose?: CatalogueGroupPurpose;
  @IsArray() @ArrayUnique() @IsIn(CATALOGUE_PLACEMENTS, { each: true }) @IsOptional() placements?: CataloguePlacement[];
  @IsUUID() @IsOptional() coverProductId?: string | null;
  @IsBoolean() @IsOptional() active?: boolean;
  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
}

export class UpdateGroupDto {
  @IsString() @IsNotEmpty() @MaxLength(160) @IsOptional() name?: string;
  @IsString() @IsOptional() description?: string;
  @IsIn(CATALOGUE_GROUP_PURPOSES) @IsOptional() purpose?: CatalogueGroupPurpose;
  @IsArray() @ArrayUnique() @IsIn(CATALOGUE_PLACEMENTS, { each: true }) @IsOptional() placements?: CataloguePlacement[];
  @IsUUID() @IsOptional() coverProductId?: string | null;
  @IsBoolean() @IsOptional() active?: boolean;
  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
}

export class SetGroupCategoriesDto {
  @IsArray() @ArrayUnique() @IsUUID('4', { each: true }) categoryIds!: string[];
}

export class UpsertCategoryPublicationDto {
  @IsBoolean() @IsOptional() visible?: boolean;
  @IsArray() @ArrayUnique() @IsIn(CATALOGUE_PLACEMENTS, { each: true }) @IsOptional()
  placements?: CataloguePlacement[];
  @IsString() @MaxLength(160) @IsOptional() publicLabel?: string | null;
  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
  @IsUUID() @IsOptional() coverProductId?: string | null;
}
