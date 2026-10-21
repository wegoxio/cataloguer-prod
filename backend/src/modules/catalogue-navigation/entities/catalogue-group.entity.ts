import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { CatalogueChannel } from './catalogue-channel.entity';
import { Product } from '../../products/entities/product.entity';
import { CataloguePlacement } from './store-category-publication.entity';

export const CATALOGUE_GROUP_PURPOSES = ['NAVIGATION', 'FILTER'] as const;
export type CatalogueGroupPurpose = (typeof CATALOGUE_GROUP_PURPOSES)[number];

@Entity({ tableName: 'catalogue_groups' })
@Unique({ properties: ['channel', 'key'] })
export class CatalogueGroup {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string;
  @ManyToOne(() => Organization, { deleteRule: 'cascade' }) organization!: Organization;
  @ManyToOne(() => Store, { deleteRule: 'cascade' }) store!: Store;
  @ManyToOne(() => CatalogueChannel, { deleteRule: 'cascade' }) channel!: CatalogueChannel;
  @Property({ length: 80 }) key!: string;
  @Property({ length: 160 }) name!: string;
  @Property({ nullable: true }) description?: string | null;
  @Property({ length: 20, default: 'FILTER' }) purpose: CatalogueGroupPurpose = 'FILTER';
  @Property({ type: 'json', defaultRaw: "'[]'::jsonb" }) placements: CataloguePlacement[] = [];
  @ManyToOne(() => Product, { nullable: true, deleteRule: 'set null' }) coverProduct?: Product | null;
  @Property({ default: true }) active = true;
  @Property({ default: 0 }) sortOrder = 0;
  @Property() createdAt = new Date();
  @Property({ onUpdate: () => new Date() }) updatedAt = new Date();
}
