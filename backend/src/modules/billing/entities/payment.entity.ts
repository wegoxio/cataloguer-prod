import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Store } from '../../stores/entities/store.entity';

/**
 * A subscription payment made by a client company. Recorded manually by
 * the platform owner (Zelle/Pago Móvil/transfer) until Stripe lands —
 * then Stripe webhooks will create these rows automatically.
 */
@Entity({ tableName: 'payments' })
export class Payment {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Store)
  store!: Store;

  @Property({ type: 'decimal', precision: 10, scale: 2 })
  amountUsd!: string;

  // e.g. "Plan Básico — julio 2026" or a Stripe invoice id later
  @Property()
  description!: string;

  @Property({ default: 'PAID' })
  status: string = 'PAID'; // PAID | PENDING | REFUNDED

  // Stripe hosted invoice page (null for manual payments)
  @Property({ nullable: true })
  invoiceUrl?: string;

  // Nullable keeps manual and pre-migration payments valid. Stripe-created
  // rows carry both identifiers; the database unique constraints are the final
  // guard when two webhook deliveries race each other.
  @Property({ nullable: true, unique: true })
  stripeEventId?: string;

  @Property({ nullable: true, unique: true })
  stripeInvoiceId?: string;

  @Property()
  paidAt!: Date;

  @Property()
  createdAt: Date = new Date();
}
