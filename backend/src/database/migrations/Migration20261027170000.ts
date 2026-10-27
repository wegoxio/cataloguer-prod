import { Migration } from '@mikro-orm/migrations';

export class Migration20261027170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "organization_plan_change_challenges" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "actor_user_id" uuid not null,
      "target_plan" varchar(255) not null,
      "code_digest" varchar(64) not null,
      "failed_attempts" int not null default 0,
      "expires_at" timestamptz not null,
      "consumed_at" timestamptz null,
      "created_at" timestamptz not null default now(),
      constraint "organization_plan_change_challenges_pkey" primary key ("id"),
      constraint "organization_plan_change_challenges_code_digest_unique" unique ("code_digest"),
      constraint "organization_plan_change_challenges_organization_fk" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete cascade,
      constraint "organization_plan_change_challenges_actor_fk" foreign key ("actor_user_id") references "users" ("id") on update cascade on delete cascade
    );`);
    this.addSql(
      `create index "organization_plan_change_challenges_organization_idx" on "organization_plan_change_challenges" ("organization_id");`,
    );
    this.addSql(
      `create index "organization_plan_change_challenges_actor_idx" on "organization_plan_change_challenges" ("actor_user_id");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "organization_plan_change_challenges" cascade;`);
  }
}
