import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'organization_plan_change_challenges' })
export class PlanChangeChallenge {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'uuid' })
  @Index()
  organizationId!: string;

  @Property({ type: 'uuid' })
  @Index()
  actorUserId!: string;

  @Property()
  targetPlan!: string;

  /** HMAC digest only. The six-digit code is never persisted or logged. */
  @Property({ length: 64, unique: true })
  codeDigest!: string;

  @Property({ type: 'int', default: 0 })
  failedAttempts = 0;

  @Property({ type: 'timestamptz' })
  expiresAt!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  consumedAt?: Date | null;

  @Property({ type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date();
}
