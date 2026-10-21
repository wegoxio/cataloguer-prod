import { Migration } from '@mikro-orm/migrations';

export class Migration20261017130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "catalogue_channels" (
      "id" uuid not null default gen_random_uuid(), "organization_id" uuid not null,
      "store_id" uuid not null, "key" varchar(80) not null, "name" varchar(160) not null,
      "description" text null, "is_default" boolean not null default false,
      "active" boolean not null default true, "sort_order" int not null default 0,
      "created_at" timestamptz not null, "updated_at" timestamptz not null,
      constraint "catalogue_channels_pkey" primary key ("id"));`);
    this.addSql(`alter table "catalogue_channels" add constraint "catalogue_channels_store_id_key_unique" unique ("store_id", "key");`);
    this.addSql(`create unique index "catalogue_channels_one_default_per_store" on "catalogue_channels" ("store_id") where "is_default" = true;`);

    this.addSql(`create table "catalogue_groups" (
      "id" uuid not null default gen_random_uuid(), "organization_id" uuid not null,
      "store_id" uuid not null, "channel_id" uuid not null, "key" varchar(80) not null,
      "name" varchar(160) not null, "description" text null, "active" boolean not null default true,
      "sort_order" int not null default 0, "created_at" timestamptz not null,
      "updated_at" timestamptz not null, constraint "catalogue_groups_pkey" primary key ("id"));`);
    this.addSql(`alter table "catalogue_groups" add constraint "catalogue_groups_channel_id_key_unique" unique ("channel_id", "key");`);

    this.addSql(`create table "store_category_publications" (
      "id" uuid not null default gen_random_uuid(), "organization_id" uuid not null,
      "store_id" uuid not null, "channel_id" uuid not null, "category_id" uuid not null,
      "cover_product_id" uuid null, "public_label" varchar(160) null,
      "placements" jsonb not null default '[]'::jsonb, "visible" boolean not null default true,
      "sort_order" int not null default 0, "created_at" timestamptz not null,
      "updated_at" timestamptz not null, constraint "store_category_publications_pkey" primary key ("id"));`);
    this.addSql(`alter table "store_category_publications" add constraint "store_category_publications_store_channel_category_unique" unique ("store_id", "channel_id", "category_id");`);
    this.addSql(`create index "store_category_publications_lookup" on "store_category_publications" ("store_id", "channel_id", "visible", "sort_order");`);

    this.addSql(`create table "catalogue_group_categories" (
      "id" uuid not null default gen_random_uuid(), "organization_id" uuid not null,
      "store_id" uuid not null, "group_id" uuid not null, "category_id" uuid not null,
      "sort_order" int not null default 0, "created_at" timestamptz not null,
      constraint "catalogue_group_categories_pkey" primary key ("id"));`);
    this.addSql(`alter table "catalogue_group_categories" add constraint "catalogue_group_categories_group_category_unique" unique ("group_id", "category_id");`);

    for (const [table, column, target] of [
      ['catalogue_channels', 'organization_id', 'organizations'], ['catalogue_channels', 'store_id', 'stores'],
      ['catalogue_groups', 'organization_id', 'organizations'], ['catalogue_groups', 'store_id', 'stores'], ['catalogue_groups', 'channel_id', 'catalogue_channels'],
      ['store_category_publications', 'organization_id', 'organizations'], ['store_category_publications', 'store_id', 'stores'], ['store_category_publications', 'channel_id', 'catalogue_channels'], ['store_category_publications', 'category_id', 'categories'],
      ['catalogue_group_categories', 'organization_id', 'organizations'], ['catalogue_group_categories', 'store_id', 'stores'], ['catalogue_group_categories', 'group_id', 'catalogue_groups'], ['catalogue_group_categories', 'category_id', 'categories'],
    ]) this.addSql(`alter table "${table}" add constraint "${table}_${column}_foreign" foreign key ("${column}") references "${target}" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "store_category_publications" add constraint "store_category_publications_cover_product_id_foreign" foreign key ("cover_product_id") references "products" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "catalogue_group_categories" cascade;');
    this.addSql('drop table if exists "store_category_publications" cascade;');
    this.addSql('drop table if exists "catalogue_groups" cascade;');
    this.addSql('drop table if exists "catalogue_channels" cascade;');
  }
}
