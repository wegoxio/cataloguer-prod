#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/cataloguer
set -a
source ./.env.infrastructure
set +a

restore_database="cataloguer_restore_test"
temporary_file="$(mktemp --suffix=.sql.gz)"

cleanup() {
  docker compose --env-file .env.infrastructure exec -T postgres \
    dropdb --if-exists --username "$POSTGRES_USER" "$restore_database" >/dev/null 2>&1 || true
  rm -f "$temporary_file"
}
trap cleanup EXIT

latest_key="$(aws s3api list-objects-v2 \
  --bucket "$BACKUP_BUCKET" \
  --prefix backups/postgres/ \
  --region "$AWS_DEFAULT_REGION" \
  --query 'sort_by(Contents,&LastModified)[-1].Key' \
  --output text)"

if [[ -z "$latest_key" || "$latest_key" == "None" ]]; then
  echo "No PostgreSQL backup was found." >&2
  exit 1
fi

aws s3 cp "s3://${BACKUP_BUCKET}/${latest_key}" "$temporary_file" \
  --region "$AWS_DEFAULT_REGION" --only-show-errors
gzip -t "$temporary_file"

docker compose --env-file .env.infrastructure exec -T postgres \
  dropdb --if-exists --username "$POSTGRES_USER" "$restore_database"
docker compose --env-file .env.infrastructure exec -T postgres \
  createdb --username "$POSTGRES_USER" "$restore_database"
gzip -dc "$temporary_file" | docker compose --env-file .env.infrastructure exec -T postgres \
  psql --set ON_ERROR_STOP=on --username "$POSTGRES_USER" --dbname "$restore_database" >/dev/null

product_count="$(docker compose --env-file .env.infrastructure exec -T postgres \
  psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$restore_database" \
  --command 'select count(*) from products;')"

echo "Restore drill passed using ${latest_key}; restored product rows: ${product_count}."
