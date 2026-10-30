import { Migration } from '@mikro-orm/migrations';

/**
 * Roles are reference data required by authorization, not optional seed data.
 * Older databases were created with a seeder that omitted
 * ORGANIZATION_MANAGER, making organization onboarding impossible to persist.
 */
export class Migration20261030120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      insert into "roles" ("id", "name") values
        (gen_random_uuid(), 'SUPER_ADMIN'),
        (gen_random_uuid(), 'ORGANIZATION_MANAGER'),
        (gen_random_uuid(), 'ADMIN'),
        (gen_random_uuid(), 'EDITOR'),
        (gen_random_uuid(), 'VIEWER')
      on conflict ("name") do nothing;
    `);
  }

  override async down(): Promise<void> {
    // Intentionally irreversible: removing reference rows can break user
    // foreign keys. Older application versions safely ignore the extra role.
  }
}
