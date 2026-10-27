import { IsIn, IsString, IsUUID, Length, Matches } from 'class-validator';
import { PLANS } from '../../stores/plans';

export class RequestPlanChangeDto {
  @IsIn(Object.keys(PLANS))
  plan!: string;
}

export class ConfirmPlanChangeDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;
}
