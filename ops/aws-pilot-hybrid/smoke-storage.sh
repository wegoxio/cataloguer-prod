#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/cataloguer
set -a
source ./.env.backend
set +a

export AWS_ACCESS_KEY_ID="$STORAGE_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$STORAGE_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="$STORAGE_REGION"

key="deployment-smoke/$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}.txt"
temporary_file="$(mktemp)"
trap 'rm -f "$temporary_file"' EXIT
printf 'cataloguer storage smoke test\n' > "$temporary_file"

aws s3api put-object --bucket "$STORAGE_BUCKET" --key "$key" --body "$temporary_file" \
  --region "$STORAGE_REGION" >/dev/null
aws s3api head-object --bucket "$STORAGE_BUCKET" --key "$key" \
  --region "$STORAGE_REGION" >/dev/null
aws s3api delete-object --bucket "$STORAGE_BUCKET" --key "$key" \
  --region "$STORAGE_REGION" >/dev/null

echo "Product image storage write/read/delete smoke test passed."
