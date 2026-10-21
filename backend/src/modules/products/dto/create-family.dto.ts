import { Transform, Type } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * One member of a family being created.
 *
 * The label cap matches `AddFamilyMemberDto` rather than the column's 255:
 * that is the cap the attach endpoint has always applied, and two endpoints
 * writing the same column to different limits is how a selector ends up with
 * an option one path allowed and the other refuses.
 */
/**
 * Trim first, then judge. `@IsNotEmpty` alone accepts "   ", which would store
 * a selector option nobody can read and a card with a blank name.
 */
const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * A LENGTH THE DATABASE AND THE BROWSER BOTH AGREE WITH.
 *
 * `@MaxLength` counts UTF-16 units, so one emoji costs two. Postgres counts
 * CHARACTERS, so `varchar(255)` holds 255 of them however wide each is. The
 * two disagree exactly where names are most interesting: a name of 200
 * emoji fits the column and is refused by the validator, and a browser
 * counting `String.length` would refuse it a second time for the same wrong
 * reason. Counting code points makes the rule the column's rule, and lets the
 * field in front of the reader apply precisely the same one.
 */
export function MaxCodePoints(max: number, options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxCodePoints',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || Array.from(value).length <= max,
        defaultMessage: () => `${propertyName} must be at most ${max} characters`,
      },
    });
  };
}

export class FamilyMemberInputDto {
  @IsUUID()
  id!: string;

  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label!: string;

  /**
   * A NEW NAME FOR THIS ITEM, applied as part of the grouping.
   *
   * Optional, because leaving a name alone is the common case and an absent
   * field must not be read as "blank". When it is present it is a real rename
   * of the product, judged by the same rules as any other product name: a
   * non-empty string within the column's 255. It is deliberately NOT the
   * label — the label is the word the selector shows for this option, and the
   * two answer different questions about the same item.
   *
   * Nothing else moves with it. The slug is what links already point at, so a
   * rename here keeps it, exactly as renaming an item anywhere else does.
   */
  @trimmed()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxCodePoints(255)
  name?: string;
}

/**
 * `POST /products/families` — and its preflight, and its retired alias.
 *
 * The endpoint had NO DTO. Its body was declared as an inline object type,
 * which erases to `Object`, and the global `ValidationPipe` skips a parameter
 * whose metatype is a native type — so `whitelist`, `forbidNonWhitelisted` and
 * every bound in the pipe's contract were silently not running on this route.
 * Nothing capped a label, nothing required a member id to be a uuid, and an
 * unknown property was accepted and ignored.
 *
 * The bounds below are the COLUMNS' own: `products.name` is varchar(255),
 * `meta_title` varchar(160), `meta_description` varchar(300) — the same limits
 * `CreateProductDto` states for the same fields.
 *
 * What is deliberately NOT here: the minimum member count. `@ArrayMinSize(2)`
 * would be a second definition of a rule `assertFamilyRequestShape` already
 * owns, and the two would drift the moment one changed. The DTO validates the
 * SHAPE of the request; the service validates the rule.
 */
export class CreateFamilyDto {
  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @trimmed()
  @IsString()
  @IsOptional()
  @MaxLength(20_000)
  description?: string;

  @trimmed()
  @IsString()
  @IsOptional()
  @MaxLength(160)
  metaTitle?: string;

  @trimmed()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  metaDescription?: string;

  @IsArray()
  @ArrayNotEmpty()
  // `ValidateNested` is what makes the pipe descend into each member, so an
  // unknown property INSIDE a member is refused too, not only at the top level.
  @ValidateNested({ each: true })
  @Type(() => FamilyMemberInputDto)
  members!: FamilyMemberInputDto[];
}
