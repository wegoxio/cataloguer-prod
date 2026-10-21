import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';

@Entity({ tableName: 'catalogue_channels' })
@Unique({ properties: ['store', 'key'] })
export class CatalogueChannel {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string;
  @ManyToOne(() => Organization, { deleteRule: 'cascade' }) organization!: Organization;
  @ManyToOne(() => Store, { deleteRule: 'cascade' }) store!: Store;
  @Property({ length: 80 }) key!: string;
  @Property({ length: 160 }) name!: string;
  @Property({ nullable: true }) description?: string | null;
  @Property({ default: false }) isDefault = false;
  @Property({ default: true }) active = true;
  @Property({ default: 0 }) sortOrder = 0;
  @Property() createdAt = new Date();
  @Property({ onUpdate: () => new Date() }) updatedAt = new Date();
}
