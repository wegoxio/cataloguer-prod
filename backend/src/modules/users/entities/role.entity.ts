import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'roles' })
export class Role {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ unique: true })
  name!: string;
}
