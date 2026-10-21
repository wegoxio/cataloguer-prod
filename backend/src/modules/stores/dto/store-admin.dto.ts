import { IsIn } from 'class-validator';
import { PLANS } from '../plans';

export class SetStorePlanDto {
  @IsIn(Object.keys(PLANS))
  plan!: string;
}
