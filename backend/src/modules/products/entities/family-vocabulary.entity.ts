import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * An option word this company taught us by accepting a family ("terra",
 * "vintage"). The detector treats these like its built-in colour/size list —
 * but only for this organization: one client's fabric names must not leak
 * into another's suggestions.
 *
 * This is vocabulary, not hierarchy. It holds no parent, no child and no
 * product reference, and nothing here can make a product a child of another —
 * only `Product.parent` does that.
 *
 */
@Entity({ tableName: 'family_vocabulary' })
@Unique({ properties: ['organization', 'word'] })
export class FamilyVocabulary {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  /** Null = the platform owner's own catalogue work (no client context). */
  @ManyToOne(() => Organization, { nullable: true, deleteRule: 'cascade' })
  organization?: Organization | null;

  /** Normalized (lowercased, stripped) single token. */
  @Property()
  word!: string;

  @Property()
  createdAt: Date = new Date();
}
