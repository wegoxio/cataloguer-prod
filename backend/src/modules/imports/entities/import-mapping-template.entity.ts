import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * A reusable, versioned mapping a tenant saved.
 *
 * Templates are what make the second import of a recurring export cheap, and
 * they are the place a silent mismapping would be most damaging: a template
 * applied to a file whose columns moved would map prices onto costs without
 * anyone re-reading the screen.
 *
 * `sourceFingerprint` is the guard. It is a digest of the ordered header names
 * and their inferred types, so reusing a template against a drifted source is
 * DETECTABLE rather than merely unlikely, and the editor can show what moved
 * instead of quietly proceeding.
 */
@Entity({ tableName: 'import_mapping_templates' })
@Unique({ properties: ['organization', 'name', 'version'] })
@Index({ properties: ['organization', 'importType'] })
export class ImportMappingTemplate {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  @Property({ fieldName: 'name', length: 160 })
  name!: string;

  /** New versions are added; an existing version is never rewritten. */
  @Property({ fieldName: 'version', default: 1 })
  version = 1;

  @Property({ fieldName: 'import_type', length: 32 })
  importType!: string;

  /** Digest of ordered header names + inferred types. Drift detector. */
  @Property({ fieldName: 'source_fingerprint', length: 64 })
  sourceFingerprint!: string;

  /** The header names themselves, so drift can be REPORTED, not just detected. */
  @Property({ fieldName: 'source_headers', type: 'json' })
  sourceHeaders!: unknown;

  /** Column→field mapping plus the declarative transformations. */
  @Property({ fieldName: 'mapping', type: 'json' })
  mapping!: unknown;

  @Property({ fieldName: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Property({ fieldName: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
