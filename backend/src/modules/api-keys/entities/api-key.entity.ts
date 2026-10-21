import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Store } from '../../stores/entities/store.entity';

/**
 * Credential for consuming the Catalogue API (ADR 005). Only a SHA-256
 * hash of the secret is stored; the full key is shown exactly once at
 * creation. `prefix` is the displayable first characters for
 * identification in the admin UI.
 */
@Entity({ tableName: 'api_keys' })
export class ApiKey {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property()
  name!: string;

  @Property({ length: 16 })
  prefix!: string;

  @Property({ unique: true, hidden: true })
  keyHash!: string;

  // The sales channel this key exposes (ADR 007). Nullable only for rows
  // predating P7.2; creation requires a store.
  @ManyToOne(() => Store, { nullable: true })
  store?: Store;

  @Property({ type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  /**
   * What this key is allowed to do (Phase 6). The database enforces the closed
   * vocabulary with a CHECK constraint; the migration stamped every existing
   * row with all three literals so pre-Phase-6 keys keep exactly the authority
   * they were issued with. New keys default to CATALOGUE_READ only.
   */
  @Property({ type: 'array', default: ['CATALOGUE_READ'] })
  capabilities: string[] = ['CATALOGUE_READ'];

  @Property({ nullable: true })
  lastUsedAt?: Date;

  @Property({ nullable: true })
  revokedAt?: Date;

  @Property()
  createdAt: Date = new Date();
}
