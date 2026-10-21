import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The text of one translation (P5-W2).
 *
 * Every field is optional because a PARTIAL translation is a normal, useful
 * state — a name translated today and a description next week. Sending a field
 * as an empty string CLEARS it; omitting it leaves whatever is stored alone,
 * so a caller editing one field cannot silently erase the other three.
 *
 * A payload that clears everything deletes the row: an empty translation is
 * not a translation, and the database refuses one anyway.
 */
export class UpsertTranslationDto {
  @IsString()
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @MaxLength(160)
  @IsOptional()
  metaTitle?: string;

  @IsString()
  @MaxLength(300)
  @IsOptional()
  metaDescription?: string;
}
