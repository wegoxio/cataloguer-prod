import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DismissSuggestionDto {
  /** The proposed parent-product name as shown on the suggestions page. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}
