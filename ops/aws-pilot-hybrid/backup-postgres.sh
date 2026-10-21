#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/cataloguer
set -a
source ./.env.infrastructure
set +a

: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
: "${AWS_DEFAULT_REGION:=eu-north-1}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
host="$(hostname -s)"
tmp_file="$(mktemp --suffix=.sql.gz)"
trap 'rm -f "$tmp_file"' EXIT

docker compose --env-file .env.infrastructure exec -T postgres \
  pg_dump --clean --if-exists --no-owner --no-privileges \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" | gzip -9 > "$tmp_file"

test -s "$tmp_file"
gzip -t "$tmp_file"
aws s3 cp "$tmp_file" "s3://${BACKUP_BUCKET}/backups/postgres/${host}/${timestamp}.sql.gz" \
  --region "$AWS_DEFAULT_REGION" --only-show-errors

echo "Backup uploaded: s3://${BACKUP_BUCKET}/backups/postgres/${host}/${timestamp}.sql.gz"
