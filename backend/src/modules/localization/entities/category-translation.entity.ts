import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Category } from '../../categories/entities/category.entity';

/**
 * One category's copy in ONE non-canonical language (P5-W2).
 *
 * The same shape and the same reasoning as `ProductTranslation`: navigation
 * labels get translated, the category stays one row, and its tree position,
 * kind, image and publication behaviour are untouched by language.
 *
 * `publicLabel` is deliberately NOT here. It is a storefront heading override
 * whose absence is meaningful ("use `name`"), and giving it a per-language
 * shadow would make "no override, in German" indistinguishable from "override
 * removed". A translated heading is a translated `name`.
 */
@Entity({ tableName: 'category_translations' })
@Unique({ properties: ['category', 'locale'] })
export class CategoryTranslation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { deleteRule: 'cascade' })
  organization!: Organization;

  @ManyToOne(() => Category, { deleteRule: 'cascade' })
  category!: Category;

  @Property({ length: 20 })
  locale!: string;

  @Property({ nullable: true })
  name?: string | null;

  @Property({ nullable: true, type: 'text' })
  description?: string | null;

  @Property({ nullable: true, length: 160 })
  metaTitle?: string | null;

  @Property({ nullable: true, length: 300 })
  metaDescription?: string | null;

  @Property()
  createdAt?: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt?: Date = new Date();
}
