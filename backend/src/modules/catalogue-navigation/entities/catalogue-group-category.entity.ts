import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { Category } from '../../categories/entities/category.entity';
import { CatalogueGroup } from './catalogue-group.entity';

@Entity({ tableName: 'catalogue_group_categories' })
@Unique({ properties: ['group', 'category'] })
export class CatalogueGroupCategory {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string;
  @ManyToOne(() => Organization, { deleteRule: 'cascade' }) organization!: Organization;
  @ManyToOne(() => Store, { deleteRule: 'cascade' }) store!: Store;
  @ManyToOne(() => CatalogueGroup, { deleteRule: 'cascade' }) group!: CatalogueGroup;
  @ManyToOne(() => Category, { deleteRule: 'cascade' }) category!: Category;
  @Property({ default: 0 }) sortOrder = 0;
  @Property() createdAt = new Date();
}
