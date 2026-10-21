import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * A grouping suggestion this company said "No" to. Its signature (the
 * normalized parent-product name) is never proposed again — neither on the
 * suggestions page nor on the next import of the same file.
 */
@Entity({ tableName: 'dismissed_suggestions' })
@Unique({ properties: ['organization', 'signature'] })
export class DismissedSuggestion {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { nullable: true, deleteRule: 'cascade' })
  organization?: Organization | null;

  /** normalizeGroupName() of the proposed parent-product name. */
  @Property()
  signature!: string;

  /** The name as it was shown, for the audit trail and debugging. */
  @Property()
  name!: string;

  @Property()
  createdAt: Date = new Date();
}
