import { IsEnum } from 'class-validator';
import { SalesOrderStatus } from '../sales-order.entity';

/** Status transition of a sales order (#173): NEW/CONFIRMED/PAID/DELIVERED/CANCELLED. */
export class SetSaleStatusDto {
  @IsEnum(SalesOrderStatus)
  status!: SalesOrderStatus;
}
