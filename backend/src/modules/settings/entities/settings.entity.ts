import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'settings' })
export class Settings {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ unique: true, default: 'global' })
  singletonKey: string = 'global';

  @Property({ nullable: true })
  companyName?: string;

  @Property({ nullable: true })
  companyEmail?: string;

  @Property({ nullable: true })
  companyPhone?: string;

  @Property({ nullable: true })
  companyAddress?: string;

  @Property({ default: 'USD' })
  currency: string = 'USD';

  @Property({ default: 'UTC' })
  timezone: string = 'UTC';

  // Platform-wide announcement shown on every client's dashboard
  @Property({ nullable: true })
  announcementTitle?: string;

  @Property({ nullable: true, type: 'text' })
  announcementBody?: string;

  @Property({ nullable: true })
  announcementUrl?: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
