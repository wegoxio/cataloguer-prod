import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class AddFamilyMemberDto {
  /** The existing product that becomes a child of the parent. */
  @IsUUID()
  productId!: string;

  /** What the website's selector shows for it, e.g. "Verde". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label!: string;
}

export class UpdateFamilyMemberDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label!: string;
}
