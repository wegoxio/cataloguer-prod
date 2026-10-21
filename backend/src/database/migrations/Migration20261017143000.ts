import { Migration } from '@mikro-orm/migrations';

export class Migration20261017143000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "catalogue_groups" add column "purpose" varchar(20) not null default 'FILTER', add column "placements" jsonb not null default '[]'::jsonb, add column "cover_product_id" uuid null;`);
    this.addSql(`alter table "catalogue_groups" add constraint "catalogue_groups_cover_product_id_foreign" foreign key ("cover_product_id") references "products" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "catalogue_groups" add constraint "catalogue_groups_purpose_check" check ("purpose" in ('NAVIGATION','FILTER'));`);
  }
  override async down(): Promise<void> {
    this.addSql(`alter table "catalogue_groups" drop constraint if exists "catalogue_groups_cover_product_id_foreign";`);
    this.addSql(`alter table "catalogue_groups" drop constraint if exists "catalogue_groups_purpose_check";`);
    this.addSql(`alter table "catalogue_groups" drop column "cover_product_id", drop column "placements", drop column "purpose";`);
  }
}
