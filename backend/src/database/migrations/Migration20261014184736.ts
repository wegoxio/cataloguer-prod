import { Migration } from '@mikro-orm/migrations';

export class Migration20261014184736 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "audit_logs" ("id" uuid not null default gen_random_uuid(), "actor_user_id" uuid null, "actor_email" varchar(255) null, "entity_type" text check ("entity_type" in ('PRODUCT', 'CATEGORY', 'PRODUCT_IMAGE', 'SETTINGS', 'USER', 'STORE', 'ORGANIZATION', 'DISCOUNT_CODE')) not null, "organization_id" uuid null, "store_id" uuid null, "entity_id" uuid not null, "action" text check ("action" in ('CREATE', 'UPDATE', 'ARCHIVE', 'DELETE', 'RESTORE', 'PUBLISH', 'UNPUBLISH', 'BULK_ARCHIVE', 'BULK_RESTORE', 'BULK_STATUS', 'BULK_CATEGORY', 'BULK_PRICING', 'BULK_INVENTORY', 'MAKE_PRIMARY', 'DEACTIVATE', 'REACTIVATE', 'PASSWORD_RESET', 'BULK_STORES')) not null, "changes" jsonb null, "message" varchar(255) null, "created_at" timestamptz not null, constraint "audit_logs_pkey" primary key ("id"));`);

    this.addSql(`create table "organizations" ("id" uuid not null default gen_random_uuid(), "name" varchar(255) not null, "slug" varchar(255) not null, "default_content_locale" varchar(20) not null default 'es', "plan" varchar(255) not null default 'BASICO', "monthly_price_usd_override" numeric(10,2) null, "monthly_price_override_plan" varchar(255) null, "billing_status" varchar(255) not null default 'ACTIVE', "stripe_customer_id" varchar(255) null, "stripe_subscription_id" varchar(255) null, "stripe_previous_subscription_id" varchar(255) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "archived_at" timestamptz null, "removed_at" timestamptz null, "inventory_cutover_frozen_at" timestamptz null, "merged_into_organization_id" uuid null, "merged_at" timestamptz null, constraint "organizations_pkey" primary key ("id"));`);
    this.addSql(`alter table "organizations" add constraint "organizations_slug_unique" unique ("slug");`);

    this.addSql(`create table "import_sources" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "object_key" varchar(512) not null, "original_file_name" varchar(512) not null, "size_bytes" bigint not null, "content_hash" varchar(64) not null, "detected_format" varchar(32) not null, "status" text check ("status" in ('PENDING', 'READY', 'REJECTED', 'EXPIRED', 'CANCELLED')) not null default 'PENDING', "rejection_reason" text null, "uploaded_by_user_id" uuid null, "uploaded_by_email" varchar(255) null, "parser_version" varchar(32) not null, "census" jsonb null, "retention_expires_at" timestamptz null, "cancelled_at" timestamptz null, "cancelled_by_user_id" uuid null, "cancelled_by_email" varchar(255) null, "cancelled_reason" text null, "object_deleted_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "import_sources_pkey" primary key ("id"));`);
    this.addSql(`create index "import_sources_content_hash_index" on "import_sources" ("content_hash");`);
    this.addSql(`create index "import_sources_organization_id_created_at_index" on "import_sources" ("organization_id", "created_at");`);
    this.addSql(`alter table "import_sources" add constraint "import_sources_organization_id_object_key_unique" unique ("organization_id", "object_key");`);

    this.addSql(`create table "import_plans" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "source_id" uuid not null, "store_id" uuid null, "import_type" text check ("import_type" in ('PRODUCTS', 'CATEGORIES', 'HISTORICAL_STORE_SALES')) not null, "sales_inventory_mode" text check ("sales_inventory_mode" in ('HISTORICAL_RECORD_ONLY')) null, "status" text check ("status" in ('DRAFT', 'READY', 'APPROVED', 'STALE', 'EXECUTING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED')) not null default 'DRAFT', "version" int not null default 1, "plan_hash" varchar(64) not null, "source_hash" varchar(64) not null, "analyzer_version" varchar(32) not null, "mapping" jsonb not null, "decisions" jsonb not null, "target_assumptions" jsonb not null, "summary" jsonb not null, "created_by_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "import_plans_pkey" primary key ("id"));`);
    this.addSql(`create index "import_plans_organization_id_status_index" on "import_plans" ("organization_id", "status");`);
    this.addSql(`alter table "import_plans" add constraint "import_plans_organization_id_plan_hash_unique" unique ("organization_id", "plan_hash");`);

    this.addSql(`create table "import_mapping_templates" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "name" varchar(160) not null, "version" int not null default 1, "import_type" varchar(32) not null, "source_fingerprint" varchar(64) not null, "source_headers" jsonb not null, "mapping" jsonb not null, "created_by_user_id" uuid null, "archived_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "import_mapping_templates_pkey" primary key ("id"));`);
    this.addSql(`create index "import_mapping_templates_organization_id_import_type_index" on "import_mapping_templates" ("organization_id", "import_type");`);
    this.addSql(`alter table "import_mapping_templates" add constraint "import_mapping_templates_organization_id_name_version_unique" unique ("organization_id", "name", "version");`);

    this.addSql(`create table "import_external_identities" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "source_system" varchar(64) not null, "external_id" varchar(255) not null, "target_type" varchar(64) not null, "target_id" uuid not null, "first_seen_at" timestamptz not null, "last_seen_at" timestamptz not null, constraint "import_external_identities_pkey" primary key ("id"));`);
    this.addSql(`create index "import_external_identities_organization_id_target__00e30_index" on "import_external_identities" ("organization_id", "target_type", "target_id");`);
    this.addSql(`alter table "import_external_identities" add constraint "import_external_identities_organization_id_source_8ef4e_unique" unique ("organization_id", "source_system", "external_id", "target_type");`);

    this.addSql(`create table "designhof_import_runs" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "source_hash" varchar(64) not null, "source_file_name" varchar(512) not null, "status" varchar(32) not null default 'PREPARED', "summary" jsonb not null default '{}'::jsonb, "started_at" timestamptz null, "finished_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "designhof_import_runs_pkey" primary key ("id"), constraint "designhof_import_runs_org_source_unique" unique ("organization_id", "source_hash"));`);
    this.addSql(`alter table "designhof_import_runs" add constraint "designhof_import_runs_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`create table "designhof_import_items" ("id" uuid not null default gen_random_uuid(), "run_id" uuid not null, "source_row" int not null, "catalog_code" varchar(255) not null, "product_id" uuid null, "parent_product_id" uuid null, "source_snapshot" jsonb not null, "stored_snapshot" jsonb null, "verification" jsonb null, "status" varchar(32) not null default 'PENDING', "error" text null, "updated_at" timestamptz not null default now(), constraint "designhof_import_items_pkey" primary key ("id"), constraint "designhof_import_items_run_code_unique" unique ("run_id", "catalog_code"));`);
    this.addSql(`alter table "designhof_import_items" add constraint "designhof_import_items_run_id_foreign" foreign key ("run_id") references "designhof_import_runs" ("id") on update cascade on delete cascade;`);
    this.addSql(`create table "designhof_import_images" ("id" uuid not null default gen_random_uuid(), "run_id" uuid not null, "catalog_code" varchar(255) not null, "product_id" uuid null, "source_url" text not null, "role" varchar(16) not null, "sort_order" int not null, "storage_key" varchar(512) null, "public_url" text null, "content_hash" varchar(64) null, "size_bytes" bigint null, "status" varchar(32) not null default 'PENDING', "attempts" int not null default 0, "error" text null, "updated_at" timestamptz not null default now(), constraint "designhof_import_images_pkey" primary key ("id"), constraint "designhof_import_images_run_product_source_unique" unique ("run_id", "catalog_code", "source_url"));`);
    this.addSql(`alter table "designhof_import_images" add constraint "designhof_import_images_run_id_foreign" foreign key ("run_id") references "designhof_import_runs" ("id") on update cascade on delete cascade;`);

    this.addSql(`create table "import_executions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "plan_id" uuid not null, "execution_identity" varchar(255) not null, "status" text check ("status" in ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED')) not null default 'QUEUED', "lease_owner" varchar(255) null, "lease_expires_at" timestamptz null, "heartbeat_at" timestamptz null, "batches_completed" int not null default 0, "batches_total" int not null default 0, "rows_created" int not null default 0, "rows_updated" int not null default 0, "rows_skipped" int not null default 0, "rows_failed" int not null default 0, "cancel_requested_at" timestamptz null, "failure_reason" text null, "started_at" timestamptz null, "finished_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "import_executions_pkey" primary key ("id"));`);
    this.addSql(`create index "import_executions_organization_id_status_index" on "import_executions" ("organization_id", "status");`);

    this.addSql(`create table "import_row_results" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "execution_id" uuid not null, "source_table" varchar(128) not null, "source_row" int not null, "outcome" text check ("outcome" in ('CREATED', 'UPDATED', 'SKIPPED', 'BLOCKED', 'FAILED', 'UNRESOLVED')) not null, "target_type" varchar(64) null, "target_id" uuid null, "match_provenance" varchar(64) null, "reason" text null, "acknowledged_warnings" jsonb null, "created_at" timestamptz not null, constraint "import_row_results_pkey" primary key ("id"));`);
    this.addSql(`create index "import_row_results_organization_id_target_type_target_id_index" on "import_row_results" ("organization_id", "target_type", "target_id");`);
    this.addSql(`alter table "import_row_results" add constraint "import_row_results_execution_id_source_row_source_table_unique" unique ("execution_id", "source_row", "source_table");`);

    this.addSql(`create table "import_checkpoints" ("id" uuid not null default gen_random_uuid(), "execution_id" uuid not null, "batch_index" int not null, "first_row" int not null, "last_row" int not null, "batch_fingerprint" varchar(64) not null, "rows_created" int not null default 0, "rows_updated" int not null default 0, "rows_skipped" int not null default 0, "rows_failed" int not null default 0, "committed_at" timestamptz not null, constraint "import_checkpoints_pkey" primary key ("id"));`);
    this.addSql(`alter table "import_checkpoints" add constraint "import_checkpoints_execution_id_batch_index_unique" unique ("execution_id", "batch_index");`);

    this.addSql(`create table "import_approvals" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "plan_id" uuid not null, "plan_version" int not null, "plan_hash" varchar(64) not null, "source_hash" varchar(64) not null, "proof_hash" varchar(64) not null, "approved_by_user_id" uuid not null, "approved_by_email" varchar(255) not null, "approved_with_role" varchar(64) not null, "approved_with_store_id" uuid null, "expires_at" timestamptz not null, "revoked_at" timestamptz null, "revoked_reason" text null, "consumed_at" timestamptz null, "created_at" timestamptz not null, constraint "import_approvals_pkey" primary key ("id"));`);
    this.addSql(`create index "import_approvals_proof_hash_index" on "import_approvals" ("proof_hash");`);
    this.addSql(`create index "import_approvals_organization_id_created_at_index" on "import_approvals" ("organization_id", "created_at");`);
    this.addSql(`alter table "import_approvals" add constraint "import_approvals_plan_id_plan_hash_unique" unique ("plan_id", "plan_hash");`);

    this.addSql(`create table "import_analyses" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "source_id" uuid not null, "status" text check ("status" in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')) not null default 'QUEUED', "source_hash" varchar(64) not null, "analyzer_version" varchar(32) not null, "execution_identity" varchar(255) null, "lease_owner" varchar(255) null, "lease_expires_at" timestamptz null, "heartbeat_at" timestamptz null, "tables" jsonb null, "proposals" jsonb null, "findings" jsonb null, "rows_analyzed" int not null default 0, "cells_analyzed" int not null default 0, "failure_reason" text null, "started_at" timestamptz null, "finished_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "import_analyses_pkey" primary key ("id"));`);
    this.addSql(`create index "import_analyses_source_id_index" on "import_analyses" ("source_id");`);
    this.addSql(`create index "import_analyses_organization_id_created_at_index" on "import_analyses" ("organization_id", "created_at");`);

    this.addSql(`create table "family_vocabulary" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid null, "word" varchar(255) not null, "created_at" timestamptz not null, constraint "family_vocabulary_pkey" primary key ("id"));`);
    this.addSql(`alter table "family_vocabulary" add constraint "family_vocabulary_organization_id_word_unique" unique ("organization_id", "word");`);

    this.addSql(`create table "dismissed_suggestions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid null, "signature" varchar(255) not null, "name" varchar(255) not null, "created_at" timestamptz not null, constraint "dismissed_suggestions_pkey" primary key ("id"));`);
    this.addSql(`alter table "dismissed_suggestions" add constraint "dismissed_suggestions_organization_id_signature_unique" unique ("organization_id", "signature");`);

    this.addSql(`create table "products" ("id" uuid not null default gen_random_uuid(), "name" varchar(255) not null, "slug" varchar(255) not null, "description" text null, "meta_title" varchar(160) null, "meta_description" varchar(300) null, "sku" varchar(255) null, "manufacturer_code" varchar(255) null, "status" text check ("status" in ('DRAFT', 'PUBLISHED', 'ARCHIVED')) not null default 'DRAFT', "sale_mode" text check ("sale_mode" in ('DIRECT', 'ON_REQUEST')) not null default 'DIRECT', "organization_id" uuid null, "parent_id" uuid null, "option_label" varchar(255) null, "price" numeric(10,2) not null default 0, "sale_price" numeric(10,2) null, "cost" numeric(10,2) null, "stock_quantity" int not null default 0, "track_inventory" boolean not null default false, "created_at" timestamptz not null, "updated_at" timestamptz not null, "archived_at" timestamptz null, constraint "products_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_transit_balances" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "transfer_id" uuid not null, "transit_direction" text not null, "product_id" uuid not null, "physical_condition" text not null, "quantity" int not null, "updated_at" timestamptz not null, constraint "inventory_transit_balances_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_opening_reconciliations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "product_id" uuid not null, "legacy_snapshot_json" jsonb not null, "legacy_product_quantity" int not null, "proposed_org_total" int not null, "approved_org_total" int null, "approved_in_transit_quantity" int not null default 0, "discrepancy_class" text not null, "discrepancy_reason" text null, "approved_by_user_id" uuid null, "approved_at" timestamptz null, "source_fingerprint" text not null, "idempotency_key" text not null, "status" text not null default 'PROPOSED', "posted_transaction_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "inventory_opening_reconciliations_pkey" primary key ("id"));`);

    this.addSql(`create table "product_field_definitions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "key" varchar(64) not null, "label" varchar(120) not null, "type" text check ("type" in ('TEXT', 'NUMBER', 'BOOLEAN', 'SELECT', 'DATE', 'URL')) not null, "unit" varchar(24) null, "source" text not null default 'CUSTOM', "field_group" varchar(64) null, "applicability" text not null default 'BOTH', "child_override_allowed" boolean not null default true, "options" jsonb null, "sort_order" int not null default 0, "archived_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "product_field_definitions_pkey" primary key ("id"));`);
    this.addSql(`alter table "product_field_definitions" add constraint "product_field_definitions_organization_id_key_unique" unique ("organization_id", "key");`);

    this.addSql(`create table "product_field_values" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "product_id" uuid not null, "definition_id" uuid not null, "definition_type" text check ("definition_type" in ('TEXT', 'NUMBER', 'BOOLEAN', 'SELECT', 'DATE', 'URL')) not null, "value_text" text null, "value_number" numeric(18,6) null, "value_boolean" boolean null, "value_date" date null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "product_field_values_pkey" primary key ("id"));`);
    this.addSql(`alter table "product_field_values" add constraint "product_field_values_product_id_definition_id_unique" unique ("product_id", "definition_id");`);

    this.addSql(`create table "product_images" ("id" uuid not null default gen_random_uuid(), "product_id" uuid not null, "url" varchar(255) not null, "storage_key" varchar(512) null, "source_url" text null, "content_hash" varchar(64) null, "alt_text" varchar(255) null, "is_primary" boolean not null default false, "display_mode" varchar(255) not null default 'CONTAIN', "sort_order" int not null default 0, "created_at" timestamptz not null, "archived_at" timestamptz null, constraint "product_images_pkey" primary key ("id"));`);
    this.addSql(`create unique index "product_images_product_source_unique" on "product_images" ("product_id", "source_url") where "source_url" is not null;`);

    this.addSql(`create table "product_relations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "source_product_id" uuid not null, "target_product_id" uuid not null, "type" text check ("type" in ('RELATED', 'ACCESSORY', 'SIMILAR', 'REPLACEMENT')) not null, "sort_order" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "product_relations_pkey" primary key ("id"));`);
    this.addSql(`alter table "product_relations" add constraint "product_relations_source_product_id_target_produc_7b1ca_unique" unique ("source_product_id", "target_product_id", "type");`);

    this.addSql(`create table "product_translations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "product_id" uuid not null, "locale" varchar(20) not null, "name" varchar(255) null, "description" text null, "meta_title" varchar(160) null, "meta_description" varchar(300) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "product_translations_pkey" primary key ("id"));`);
    this.addSql(`alter table "product_translations" add constraint "product_translations_product_id_locale_unique" unique ("product_id", "locale");`);

    this.addSql(`create table "roles" ("id" uuid not null default gen_random_uuid(), "name" varchar(255) not null, constraint "roles_pkey" primary key ("id"));`);
    this.addSql(`alter table "roles" add constraint "roles_name_unique" unique ("name");`);

    this.addSql(`create table "settings" ("id" uuid not null default gen_random_uuid(), "singleton_key" varchar(255) not null default 'global', "company_name" varchar(255) null, "company_email" varchar(255) null, "company_phone" varchar(255) null, "company_address" varchar(255) null, "currency" varchar(255) not null default 'USD', "timezone" varchar(255) not null default 'UTC', "announcement_title" varchar(255) null, "announcement_body" text null, "announcement_url" varchar(255) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "settings_pkey" primary key ("id"));`);
    this.addSql(`alter table "settings" add constraint "settings_singleton_key_unique" unique ("singleton_key");`);

    this.addSql(`create table "stores" ("id" uuid not null default gen_random_uuid(), "name" varchar(255) not null, "slug" varchar(255) not null, "organization_id" uuid null, "website_url" varchar(255) null, "website_product_path" varchar(255) null default '/products/{slug}', "website_category_path" varchar(255) null default '/categories/{slug}', "contact_email" varchar(255) null, "contact_phone" varchar(255) null, "contact_address" varchar(255) null, "hidden_modules" jsonb null, "archived_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "stores_pkey" primary key ("id"));`);
    this.addSql(`alter table "stores" add constraint "stores_slug_unique" unique ("slug");`);

    this.addSql(`create table "sales_orders" ("id" uuid not null default gen_random_uuid(), "store_id" uuid not null, "organization_id" uuid null, "order_number" varchar(255) not null, "idempotency_key" varchar(255) null, "status" varchar(255) not null default 'NEW', "customer_name" varchar(255) null, "customer_phone" varchar(255) null, "total_usd" numeric(10,2) not null, "discount_code" varchar(255) null, "discount_usd" numeric(10,2) not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "sales_orders_pkey" primary key ("id"));`);
    this.addSql(`alter table "sales_orders" add constraint "sales_orders_order_number_unique" unique ("order_number");`);
    this.addSql(`alter table "sales_orders" add constraint "sales_orders_idempotency_key_unique" unique ("idempotency_key");`);

    this.addSql(`create table "sales_order_items" ("id" uuid not null default gen_random_uuid(), "order_id" uuid not null, "product_id" uuid null, "product_name" varchar(255) not null, "variant_name" varchar(255) null, "unit_price_usd" numeric(10,2) not null, "quantity" int not null, "stock_deducted" int not null default 0, constraint "sales_order_items_pkey" primary key ("id"));`);

    this.addSql(`create table "payments" ("id" uuid not null default gen_random_uuid(), "store_id" uuid not null, "amount_usd" numeric(10,2) not null, "description" varchar(255) not null, "status" varchar(255) not null default 'PAID', "invoice_url" varchar(255) null, "stripe_event_id" varchar(255) null, "stripe_invoice_id" varchar(255) null, "paid_at" timestamptz not null, "created_at" timestamptz not null, constraint "payments_pkey" primary key ("id"));`);
    this.addSql(`alter table "payments" add constraint "payments_stripe_event_id_unique" unique ("stripe_event_id");`);
    this.addSql(`alter table "payments" add constraint "payments_stripe_invoice_id_unique" unique ("stripe_invoice_id");`);

    this.addSql(`create table "inventory_transactions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "type" text not null, "idempotency_key" text not null, "command_fingerprint" text not null, "scope_product_id" uuid null, "audit_store_id" uuid null, "actor_kind" text not null, "actor_user_id" uuid null, "actor_email" text null, "system_origin" text null, "sales_order_id" uuid null, "transfer_id" uuid null, "posted_at" timestamptz not null, constraint "inventory_transactions_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_transaction_intents" ("id" uuid not null default gen_random_uuid(), "transaction_id" uuid not null, "organization_id" uuid not null, "product_id" uuid not null, "declared_amount" int not null, "intent_sign" smallint not null, constraint "inventory_transaction_intents_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_locations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "kind" text not null, "code" text not null, "name" text not null, "store_id" uuid null, "is_default" boolean not null default false, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "inventory_locations_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_transfers" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "source_location_id" uuid not null, "destination_location_id" uuid not null, "status" text not null default 'DRAFT', "reference" text null, "actor_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "inventory_transfers_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_transfer_lines" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "transfer_id" uuid not null, "product_id" uuid not null, "physical_condition" text not null default 'GOOD', "quantity" int not null, "dispatched_quantity" int not null default 0, "received_quantity" int not null default 0, "returning_quantity" int not null default 0, "returned_quantity" int not null default 0, constraint "inventory_transfer_lines_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_reservations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "product_id" uuid not null, "location_id" uuid not null, "physical_condition" text not null, "quantity" int not null, "status" text not null default 'ACTIVE', "customer_name" text null, "customer_phone" text null, "customer_email" text null, "customer_id" uuid null, "sales_order_id" uuid null, "reserve_transaction_id" uuid not null, "settle_transaction_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "inventory_reservations_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_opening_reconciliation_allocations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "reconciliation_id" uuid not null, "destination_location_id" uuid not null, "approved_quantity" int not null, "created_at" timestamptz not null, constraint "inventory_opening_reconciliation_allocations_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_entries" ("id" uuid not null default gen_random_uuid(), "transaction_id" uuid not null, "organization_id" uuid not null, "product_id" uuid not null, "location_id" uuid null, "physical_condition" text not null, "operational_state" text not null, "transfer_id" uuid null, "transit_direction" text null, "quantity_delta" int not null, "created_at" timestamptz not null, constraint "inventory_entries_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_balances" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "location_id" uuid not null, "product_id" uuid not null, "physical_condition" text not null, "operational_state" text not null, "quantity" int not null, "updated_at" timestamptz not null, constraint "inventory_balances_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_backorders" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "product_id" uuid not null, "store_id" uuid null, "quantity" int not null, "allocated_quantity" int not null default 0, "origin" text not null, "status" text not null default 'OPEN', "customer_name" text null, "customer_phone" text null, "customer_email" text null, "customer_id" uuid null, "sales_order_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "inventory_backorders_pkey" primary key ("id"));`);

    this.addSql(`create table "inventory_backorder_allocations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "backorder_id" uuid not null, "reservation_id" uuid not null, "quantity" int not null, "allocated_at" timestamptz not null, constraint "inventory_backorder_allocations_pkey" primary key ("id"));`);

    this.addSql(`create table "imported_historical_sales" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "store_id" uuid not null, "product_id" uuid null, "item_text" varchar(500) not null, "variant_text" varchar(255) null, "quantity" numeric(14,3) not null, "unit_price" numeric(14,2) null, "line_total" numeric(14,2) null, "currency" varchar(3) null, "occurred_at" timestamptz not null, "external_ref" varchar(255) null, "customer_reference" varchar(255) null, "stock_deducted" boolean not null default false, "execution_id" uuid not null, "source_table" varchar(128) not null, "source_row" int not null, "created_at" timestamptz not null, constraint "imported_historical_sales_pkey" primary key ("id"));`);
    this.addSql(`create index "imported_historical_sales_store_id_occurred_at_index" on "imported_historical_sales" ("store_id", "occurred_at");`);
    this.addSql(`alter table "imported_historical_sales" add constraint "imported_historical_sales_execution_id_source_tab_e65f9_unique" unique ("execution_id", "source_table", "source_row");`);

    this.addSql(`create table "discount_codes" ("id" uuid not null default gen_random_uuid(), "store_id" uuid not null, "code" varchar(255) not null, "type" varchar(255) not null default 'PERCENT', "value" numeric(10,2) not null, "applies_to" varchar(255) not null default 'ORDER', "product_ids" jsonb not null, "category_ids" jsonb not null, "min_order_usd" numeric(10,2) null, "max_uses" int null, "used_count" int not null default 0, "expires_at" timestamptz null, "active" boolean not null default true, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "discount_codes_pkey" primary key ("id"));`);

    this.addSql(`create table "categories" ("id" uuid not null default gen_random_uuid(), "name" varchar(255) not null, "slug" varchar(255) not null, "description" varchar(255) null, "meta_title" varchar(160) null, "meta_description" varchar(300) null, "organization_id" uuid null, "store_id" uuid null, "parent_category_id" uuid null, "kind" varchar(255) null, "public_label" varchar(160) null, "sort_order" int not null default 0, "show_in_navigation" boolean not null default true, "created_at" timestamptz not null, "updated_at" timestamptz not null, "archived_at" timestamptz null, constraint "categories_pkey" primary key ("id"));`);
    this.addSql(`alter table "categories" add constraint "categories_id_organization_id_unique" unique ("id", "organization_id");`);

    this.addSql(`create table "product_categories" ("product_id" uuid not null, "category_id" uuid not null, constraint "product_categories_pkey" primary key ("product_id", "category_id"));`);

    this.addSql(`create table "category_translations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "category_id" uuid not null, "locale" varchar(20) not null, "name" varchar(255) null, "description" text null, "meta_title" varchar(160) null, "meta_description" varchar(300) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "category_translations_pkey" primary key ("id"));`);
    this.addSql(`alter table "category_translations" add constraint "category_translations_category_id_locale_unique" unique ("category_id", "locale");`);

    this.addSql(`create table "api_keys" ("id" uuid not null default gen_random_uuid(), "name" varchar(255) not null, "prefix" varchar(16) not null, "key_hash" varchar(255) not null, "store_id" uuid null, "created_by_user_id" uuid null, "capabilities" text[] not null default '{CATALOGUE_READ}', "last_used_at" timestamptz null, "revoked_at" timestamptz null, "created_at" timestamptz not null, constraint "api_keys_pkey" primary key ("id"));`);
    this.addSql(`alter table "api_keys" add constraint "api_keys_key_hash_unique" unique ("key_hash");`);

    this.addSql(`create table "store_field_settings" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "store_id" uuid not null, "definition_id" uuid not null, "active" boolean not null default false, "required" boolean not null default false, "publicly_visible" boolean not null default false, "importable" boolean not null default false, "filterable" boolean not null default false, "sort_order" int null, "label_override" varchar(120) null, "group_override" varchar(64) null, "display_unit" varchar(24) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "store_field_settings_pkey" primary key ("id"));`);
    this.addSql(`alter table "store_field_settings" add constraint "store_field_settings_store_id_definition_id_unique" unique ("store_id", "definition_id");`);

    this.addSql(`create table "store_products" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid null, "store_id" uuid not null, "product_id" uuid not null, "published" boolean not null default false, "price" numeric(10,2) null, "sale_price" numeric(10,2) null, "cost" numeric(10,2) null, "stock_quantity" int not null default 0, "track_inventory" boolean not null default false, "lead_time_days" int null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "store_products_pkey" primary key ("id"));`);
    this.addSql(`alter table "store_products" add constraint "store_products_store_id_product_id_unique" unique ("store_id", "product_id");`);

    this.addSql(`create table "users" ("id" uuid not null default gen_random_uuid(), "email" varchar(255) not null, "password_hash" varchar(255) null, "first_name" varchar(255) null, "last_name" varchar(255) null, "company" varchar(255) null, "role_id" uuid not null, "organization_id" uuid null, "store_id" uuid null, "terms_accepted_at" timestamptz null, "mfa_pending_secret" varchar(255) null, "mfa_pending_expires_at" timestamptz null, "mfa_secret_enc" text null, "mfa_enabled_at" timestamptz null, "mfa_recovery_codes" jsonb null, "failed_login_attempts" int not null default 0, "locked_until" timestamptz null, "pending_email" varchar(255) null, "email_change_token_hash" varchar(255) null, "email_change_expires_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, "auth_generation" int not null default 1, constraint "users_pkey" primary key ("id"));`);

    this.addSql(`create table "refresh_tokens" ("id" uuid not null, "user_id" uuid not null, "token_hash" varchar(255) not null, "expires_at" timestamptz not null, "revoked_at" timestamptz null, "replaced_by_id" uuid null, "ip" varchar(255) null, "user_agent" varchar(255) null, "created_at" timestamptz not null, constraint "refresh_tokens_pkey" primary key ("id"));`);
    this.addSql(`create index "refresh_tokens_user_id_index" on "refresh_tokens" ("user_id");`);

    this.addSql(`create table "password_reset_tokens" ("id" uuid not null default gen_random_uuid(), "user_id" uuid not null, "token_hash" varchar(255) not null, "expires_at" timestamptz not null, "used_at" timestamptz null, "created_at" timestamptz not null, constraint "password_reset_tokens_pkey" primary key ("id"));`);
    this.addSql(`alter table "password_reset_tokens" add constraint "password_reset_tokens_token_hash_unique" unique ("token_hash");`);

    this.addSql(`alter table "import_sources" add constraint "import_sources_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "import_plans" add constraint "import_plans_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "import_plans" add constraint "import_plans_source_id_foreign" foreign key ("source_id") references "import_sources" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "import_mapping_templates" add constraint "import_mapping_templates_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "import_external_identities" add constraint "import_external_identities_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "import_executions" add constraint "import_executions_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "import_executions" add constraint "import_executions_plan_id_foreign" foreign key ("plan_id") references "import_plans" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "import_row_results" add constraint "import_row_results_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "import_row_results" add constraint "import_row_results_execution_id_foreign" foreign key ("execution_id") references "import_executions" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "import_checkpoints" add constraint "import_checkpoints_execution_id_foreign" foreign key ("execution_id") references "import_executions" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "import_approvals" add constraint "import_approvals_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "import_approvals" add constraint "import_approvals_plan_id_foreign" foreign key ("plan_id") references "import_plans" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "import_analyses" add constraint "import_analyses_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "import_analyses" add constraint "import_analyses_source_id_foreign" foreign key ("source_id") references "import_sources" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "family_vocabulary" add constraint "family_vocabulary_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "dismissed_suggestions" add constraint "dismissed_suggestions_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "products" add constraint "products_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "products" add constraint "products_parent_id_foreign" foreign key ("parent_id") references "products" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "inventory_transit_balances" add constraint "inventory_transit_balances_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transit_balances" add constraint "inventory_transit_balances_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_opening_reconciliations" add constraint "inventory_opening_reconciliations_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_opening_reconciliations" add constraint "inventory_opening_reconciliations_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);

    this.addSql(`alter table "product_field_definitions" add constraint "product_field_definitions_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "product_field_values" add constraint "product_field_values_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "product_field_values" add constraint "product_field_values_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "product_field_values" add constraint "product_field_values_definition_id_foreign" foreign key ("definition_id") references "product_field_definitions" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "product_images" add constraint "product_images_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);

    this.addSql(`alter table "product_relations" add constraint "product_relations_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "product_relations" add constraint "product_relations_source_product_id_foreign" foreign key ("source_product_id") references "products" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "product_relations" add constraint "product_relations_target_product_id_foreign" foreign key ("target_product_id") references "products" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "product_translations" add constraint "product_translations_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "product_translations" add constraint "product_translations_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "stores" add constraint "stores_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "sales_orders" add constraint "sales_orders_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade;`);
    this.addSql(`alter table "sales_orders" add constraint "sales_orders_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "sales_order_items" add constraint "sales_order_items_order_id_foreign" foreign key ("order_id") references "sales_orders" ("id") on update cascade;`);
    this.addSql(`alter table "sales_order_items" add constraint "sales_order_items_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "payments" add constraint "payments_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_transactions" add constraint "inventory_transactions_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transactions" add constraint "inventory_transactions_scope_product_id_foreign" foreign key ("scope_product_id") references "products" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "inventory_transactions" add constraint "inventory_transactions_audit_store_id_foreign" foreign key ("audit_store_id") references "stores" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "inventory_transaction_intents" add constraint "inventory_transaction_intents_transaction_id_foreign" foreign key ("transaction_id") references "inventory_transactions" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transaction_intents" add constraint "inventory_transaction_intents_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transaction_intents" add constraint "inventory_transaction_intents_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_locations" add constraint "inventory_locations_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_locations" add constraint "inventory_locations_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "inventory_transfers" add constraint "inventory_transfers_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transfers" add constraint "inventory_transfers_source_location_id_foreign" foreign key ("source_location_id") references "inventory_locations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transfers" add constraint "inventory_transfers_destination_location_id_foreign" foreign key ("destination_location_id") references "inventory_locations" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_transfer_lines" add constraint "inventory_transfer_lines_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transfer_lines" add constraint "inventory_transfer_lines_transfer_id_foreign" foreign key ("transfer_id") references "inventory_transfers" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_transfer_lines" add constraint "inventory_transfer_lines_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_reservations" add constraint "inventory_reservations_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_reservations" add constraint "inventory_reservations_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_reservations" add constraint "inventory_reservations_location_id_foreign" foreign key ("location_id") references "inventory_locations" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_opening_reconciliation_allocations" add constraint "inventory_opening_reconciliation_allocations_org_6df3c_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_opening_reconciliation_allocations" add constraint "inventory_opening_reconciliation_allocations_rec_2693d_foreign" foreign key ("reconciliation_id") references "inventory_opening_reconciliations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_opening_reconciliation_allocations" add constraint "inventory_opening_reconciliation_allocations_des_a0863_foreign" foreign key ("destination_location_id") references "inventory_locations" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_entries" add constraint "inventory_entries_transaction_id_foreign" foreign key ("transaction_id") references "inventory_transactions" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_entries" add constraint "inventory_entries_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_entries" add constraint "inventory_entries_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_entries" add constraint "inventory_entries_location_id_foreign" foreign key ("location_id") references "inventory_locations" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "inventory_balances" add constraint "inventory_balances_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_balances" add constraint "inventory_balances_location_id_foreign" foreign key ("location_id") references "inventory_locations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_balances" add constraint "inventory_balances_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);

    this.addSql(`alter table "inventory_backorders" add constraint "inventory_backorders_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_backorders" add constraint "inventory_backorders_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_backorders" add constraint "inventory_backorders_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "inventory_backorder_allocations" add constraint "inventory_backorder_allocations_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_backorder_allocations" add constraint "inventory_backorder_allocations_backorder_id_foreign" foreign key ("backorder_id") references "inventory_backorders" ("id") on update cascade;`);
    this.addSql(`alter table "inventory_backorder_allocations" add constraint "inventory_backorder_allocations_reservation_id_foreign" foreign key ("reservation_id") references "inventory_reservations" ("id") on update cascade;`);

    this.addSql(`alter table "imported_historical_sales" add constraint "imported_historical_sales_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "imported_historical_sales" add constraint "imported_historical_sales_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "imported_historical_sales" add constraint "imported_historical_sales_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "imported_historical_sales" add constraint "imported_historical_sales_execution_id_foreign" foreign key ("execution_id") references "import_executions" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "discount_codes" add constraint "discount_codes_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade;`);

    this.addSql(`alter table "categories" add constraint "categories_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "categories" add constraint "categories_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "categories" add constraint "categories_parent_category_id_foreign" foreign key ("parent_category_id") references "categories" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "product_categories" add constraint "product_categories_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "product_categories" add constraint "product_categories_category_id_foreign" foreign key ("category_id") references "categories" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "category_translations" add constraint "category_translations_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "category_translations" add constraint "category_translations_category_id_foreign" foreign key ("category_id") references "categories" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "api_keys" add constraint "api_keys_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "store_field_settings" add constraint "store_field_settings_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "store_field_settings" add constraint "store_field_settings_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "store_field_settings" add constraint "store_field_settings_definition_id_foreign" foreign key ("definition_id") references "product_field_definitions" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "store_products" add constraint "store_products_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "store_products" add constraint "store_products_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "store_products" add constraint "store_products_product_id_foreign" foreign key ("product_id") references "products" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "users" add constraint "users_role_id_foreign" foreign key ("role_id") references "roles" ("id") on update cascade;`);
    this.addSql(`alter table "users" add constraint "users_organization_id_foreign" foreign key ("organization_id") references "organizations" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "users" add constraint "users_store_id_foreign" foreign key ("store_id") references "stores" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "refresh_tokens" add constraint "refresh_tokens_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade;`);

    this.addSql(`alter table "password_reset_tokens" add constraint "password_reset_tokens_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade;`);

    this.addSql(`alter table "stores" add column "removed_at" timestamptz null;`);
    this.addSql(`alter table "products" add column "removed_at" timestamptz null;`);
    this.addSql(`alter table "categories" add column "removed_at" timestamptz null;`);
    this.addSql(`alter table "users" add column "removed_at" timestamptz null;`);
    this.addSql(`alter table "discount_codes" add column "removed_at" timestamptz null;`);

    // Inventory invariants used by the posting service. These are deliberately
    // part of the baseline because MikroORM metadata cannot describe partial
    // write doors or projection guards.
    this.addSql(`alter table "inventory_transactions" add constraint "inventory_transactions_org_idempotency_unique" unique ("organization_id", "idempotency_key");`);
    this.addSql(`alter table "inventory_transactions" add constraint "inventory_transactions_actor_check" check (("actor_kind" = 'USER' and "actor_user_id" is not null and "system_origin" is null) or ("actor_kind" = 'SYSTEM' and "actor_user_id" is null and "system_origin" is not null));`);
    this.addSql(`alter table "inventory_balances" add constraint "inventory_balances_cell_unique" unique ("organization_id", "location_id", "product_id", "physical_condition", "operational_state");`);
    this.addSql(`alter table "inventory_balances" add constraint "inventory_balances_nonnegative_check" check ("quantity" >= 0);`);
    this.addSql(`alter table "inventory_transit_balances" add constraint "inventory_transit_balances_cell_unique" unique ("organization_id", "transfer_id", "transit_direction", "product_id", "physical_condition");`);
    this.addSql(`alter table "inventory_transit_balances" add constraint "inventory_transit_balances_nonnegative_check" check ("quantity" >= 0);`);

    this.addSql(`
      create function inventory_definer_insert_transaction(
        p_organization_id uuid, p_type text, p_idempotency_key text,
        p_command_fingerprint text, p_scope_product_id uuid,
        p_audit_store_id uuid, p_actor_kind text, p_actor_user_id uuid,
        p_actor_email text, p_system_origin text, p_sales_order_id uuid,
        p_transfer_id uuid
      ) returns uuid
      language plpgsql security definer set search_path = pg_catalog, public
      as $$
      declare v_id uuid;
      begin
        insert into inventory_transactions
          (organization_id, type, idempotency_key, command_fingerprint,
           scope_product_id, audit_store_id, actor_kind, actor_user_id,
           actor_email, system_origin, sales_order_id, transfer_id, posted_at)
        values
          (p_organization_id, p_type, p_idempotency_key, p_command_fingerprint,
           p_scope_product_id, p_audit_store_id, p_actor_kind, p_actor_user_id,
           p_actor_email, p_system_origin, p_sales_order_id, p_transfer_id, now())
        on conflict (organization_id, idempotency_key) do nothing
        returning id into v_id;
        return v_id;
      end $$;
    `);
    this.addSql(`
      create function inventory_definer_insert_intent(
        p_transaction_id uuid, p_organization_id uuid, p_product_id uuid,
        p_declared_amount integer, p_intent_sign smallint
      ) returns void
      language sql security definer set search_path = pg_catalog, public
      as $$ insert into inventory_transaction_intents
        (transaction_id, organization_id, product_id, declared_amount, intent_sign)
        values (p_transaction_id, p_organization_id, p_product_id, p_declared_amount, p_intent_sign) $$;
    `);
    this.addSql(`
      create function inventory_definer_insert_entry(
        p_transaction_id uuid, p_organization_id uuid, p_product_id uuid,
        p_location_id uuid, p_physical_condition text, p_operational_state text,
        p_transfer_id uuid, p_transit_direction text, p_quantity_delta integer
      ) returns void
      language sql security definer set search_path = pg_catalog, public
      as $$ insert into inventory_entries
        (transaction_id, organization_id, product_id, location_id,
         physical_condition, operational_state, transfer_id, transit_direction,
         quantity_delta, created_at)
        values (p_transaction_id, p_organization_id, p_product_id, p_location_id,
         p_physical_condition, p_operational_state, p_transfer_id,
         p_transit_direction, p_quantity_delta, now()) $$;
    `);
    this.addSql(`
      create function inventory_definer_apply_balance(
        p_organization_id uuid, p_location_id uuid, p_product_id uuid,
        p_physical_condition text, p_operational_state text,
        p_quantity_delta integer
      ) returns void
      language plpgsql security definer set search_path = pg_catalog, public
      as $$
      begin
        insert into inventory_balances
          (organization_id, location_id, product_id, physical_condition,
           operational_state, quantity, updated_at)
        values (p_organization_id, p_location_id, p_product_id,
          p_physical_condition, p_operational_state, 0, now())
        on conflict (organization_id, location_id, product_id,
          physical_condition, operational_state) do nothing;
        update inventory_balances set quantity = quantity + p_quantity_delta,
          updated_at = now()
        where organization_id = p_organization_id and location_id = p_location_id
          and product_id = p_product_id
          and physical_condition = p_physical_condition
          and operational_state = p_operational_state;
      end $$;
    `);
    this.addSql(`
      create function inventory_definer_apply_transit_balance(
        p_organization_id uuid, p_transfer_id uuid, p_transit_direction text,
        p_product_id uuid, p_physical_condition text, p_quantity_delta integer
      ) returns void
      language plpgsql security definer set search_path = pg_catalog, public
      as $$
      begin
        insert into inventory_transit_balances
          (organization_id, transfer_id, transit_direction, product_id,
           physical_condition, quantity, updated_at)
        values (p_organization_id, p_transfer_id, p_transit_direction,
          p_product_id, p_physical_condition, 0, now())
        on conflict (organization_id, transfer_id, transit_direction,
          product_id, physical_condition) do nothing;
        update inventory_transit_balances set quantity = quantity + p_quantity_delta,
          updated_at = now()
        where organization_id = p_organization_id and transfer_id = p_transfer_id
          and transit_direction = p_transit_direction and product_id = p_product_id
          and physical_condition = p_physical_condition;
      end $$;
    `);
  }

}
