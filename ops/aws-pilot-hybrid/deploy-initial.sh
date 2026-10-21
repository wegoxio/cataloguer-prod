#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/cataloguer
compose=(docker compose --env-file .env.infrastructure)

"${compose[@]}" config --quiet
"${compose[@]}" up -d postgres

wait_healthy() {
  local service="$1"
  local container state
  container="$("${compose[@]}" ps -q "$service")"
  for _attempt in $(seq 1 45); do
    state="$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    if [[ "$state" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  "${compose[@]}" logs --tail=100 "$service"
  echo "Service ${service} did not become healthy (last state: ${state:-missing})." >&2
  return 1
}

wait_healthy postgres
"${compose[@]}" run --rm backend node dist/jobs/migrate.main.js
"${compose[@]}" up -d backend
wait_healthy backend
"${compose[@]}" ps
