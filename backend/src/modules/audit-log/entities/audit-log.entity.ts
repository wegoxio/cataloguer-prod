import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/core';

export enum EntityType {
  PRODUCT = 'PRODUCT',
  CATEGORY = 'CATEGORY',
  PRODUCT_IMAGE = 'PRODUCT_IMAGE',
  /**
   * HISTORICAL ONLY (ADR 009, ADR 018). The legacy variant model is gone and
   * nothing writes this value any more, but audit rows recorded before its
   * retirement still carry it and `audit_logs_entity_type_check` still admits
   * it. Kept so the past stays readable; never widen its use.
   */
  SETTINGS = 'SETTINGS',
  USER = 'USER',
  STORE = 'STORE',
  ORGANIZATION = 'ORGANIZATION',
  DISCOUNT_CODE = 'DISCOUNT_CODE',
}

export enum Action {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  ARCHIVE = 'ARCHIVE',
  DELETE = 'DELETE',
  RESTORE = 'RESTORE',
  PUBLISH = 'PUBLISH',
  UNPUBLISH = 'UNPUBLISH',
  BULK_ARCHIVE = 'BULK_ARCHIVE',
  BULK_RESTORE = 'BULK_RESTORE',
  BULK_STATUS = 'BULK_STATUS',
  BULK_CATEGORY = 'BULK_CATEGORY',
  BULK_PRICING = 'BULK_PRICING',
  BULK_INVENTORY = 'BULK_INVENTORY',
  MAKE_PRIMARY = 'MAKE_PRIMARY',
  DEACTIVATE = 'DEACTIVATE',
  REACTIVATE = 'REACTIVATE',
  PASSWORD_RESET = 'PASSWORD_RESET',
  BULK_STORES = 'BULK_STORES',
}

@Entity({ tableName: 'audit_logs' })
export class AuditLog {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'uuid', nullable: true })
  actorUserId?: string | null;

  @Property({ nullable: true })
  actorEmail?: string | null;

  @Enum(() => EntityType)
  entityType!: EntityType;

  /**
   * Tenant context (P0-13). Plain uuids, deliberately WITHOUT foreign keys:
   * an audit row must outlive whatever it describes, or the trail dies with
   * its subject. Null = a platform-level action.
   */
  @Property({ type: 'uuid', nullable: true })
  organizationId?: string | null;

  @Property({ type: 'uuid', nullable: true })
  storeId?: string | null;

  @Property({ type: 'uuid' })
  entityId!: string;

  @Enum(() => Action)
  action!: Action;

  @Property({ type: 'json', nullable: true })
  changes?: Record<string, any> | null;

  @Property({ nullable: true })
  message?: string | null;

  @Property()
  createdAt: Date = new Date();
}
