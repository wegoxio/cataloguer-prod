import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { Category } from '../../categories/entities/category.entity';
import { Product } from '../../products/entities/product.entity';
import { CatalogueChannel } from './catalogue-channel.entity';

export const CATALOGUE_PLACEMENTS = ['HOME', 'CATALOG', 'NAVIGATION'] as const;
export type CataloguePlacement = (typeof CATALOGUE_PLACEMENTS)[number];

@Entity({ tableName: 'store_category_publications' })
@Unique({ properties: ['store', 'channel', 'category'] })
export class StoreCategoryPublication {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string;
  @ManyToOne(() => Organization, { deleteRule: 'cascade' }) organization!: Organization;
  @ManyToOne(() => Store, { deleteRule: 'cascade' }) store!: Store;
  @ManyToOne(() => CatalogueChannel, { deleteRule: 'cascade' }) channel!: CatalogueChannel;
  @ManyToOne(() => Category, { deleteRule: 'cascade' }) category!: Category;
  @ManyToOne(() => Product, { nullable: true, deleteRule: 'set null' }) coverProduct?: Product | null;
  @Property({ nullable: true, length: 160 }) publicLabel?: string | null;
  @Property({ type: 'json', defaultRaw: "'[]'::jsonb" }) placements: CataloguePlacement[] = [];
  @Property({ default: true }) visible = true;
  @Property({ default: 0 }) sortOrder = 0;
  @Property() createdAt = new Date();
  @Property({ onUpdate: () => new Date() }) updatedAt = new Date();
}
