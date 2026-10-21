import { Entity, PrimaryKey, Property, ManyToOne } from '@mikro-orm/core';
import { Product } from '../../products/entities/product.entity';

@Entity({ tableName: 'product_images' })
export class ProductImage {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Product)
  product!: Product;

  @Property()
  url!: string;

  /** Canonical object key, independent from the bucket's public hostname. */
  @Property({ nullable: true, length: 512 })
  storageKey?: string | null;

  /** Original URL retained internally for idempotency and migration evidence. */
  @Property({ nullable: true, type: 'text' })
  sourceUrl?: string | null;

  /** SHA-256 of the uploaded bytes. */
  @Property({ nullable: true, length: 64 })
  contentHash?: string | null;

  @Property({ nullable: true })
  altText?: string;

  @Property({ type: 'boolean', default: false })
  isPrimary!: boolean;

  // How websites should frame it: CONTAIN = whole photo on white (safe
  // default), COVER = fill the frame, cropping edges
  @Property({ default: 'CONTAIN' })
  displayMode: string = 'CONTAIN';

  @Property({ type: 'integer', default: 0 })
  sortOrder!: number;

  @Property()
  createdAt?: Date = new Date();

  @Property({ nullable: true })
  archivedAt?: Date;
}
