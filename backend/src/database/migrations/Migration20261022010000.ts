import { Migration } from '@mikro-orm/migrations';

export class Migration20261022010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "categories" add column "image_url" varchar(2048) null, add column "image_object_key" varchar(512) null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "categories" drop column "image_url", drop column "image_object_key";`);
  }
}
