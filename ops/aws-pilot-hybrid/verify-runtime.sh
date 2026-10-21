#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/cataloguer
compose=(docker compose --env-file .env.infrastructure)

"${compose[@]}" up -d --force-recreate backend
bash smoke-storage.sh
bash backup-postgres.sh
"${compose[@]}" ps
"${compose[@]}" exec -T backend node -e \
  "fetch('http://127.0.0.1:3001/api/v1/health').then(async response => { console.log(response.status, await response.text()); process.exit(response.ok ? 0 : 1); }).catch(error => { console.error(error.message); process.exit(1); });"
