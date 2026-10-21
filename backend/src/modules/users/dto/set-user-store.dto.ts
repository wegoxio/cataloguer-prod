import { IsOptional, IsUUID } from 'class-validator';

/**
 * The one store this user will be bound to, or null to unbind (which the
 * service allows only for the platform owner). This was an inline body type —
 * and an inline type is invisible to the global ValidationPipe, so the route
 * accepted any shape at all and left the service to sort it out. Phase 8's
 * contract rule: every mutating route names its body as a class.
 */
export class SetUserStoreDto {
  @IsOptional()
  @IsUUID()
  storeId?: string | null;
}
