#!/usr/bin/env bash
set -Eeuo pipefail

# Atomic single-instance release for the Cataloguer Lightsail pilot.
# The image is built and tested by GitHub Actions, then copied as a tarball.
# Only one release (manual or automatic) may mutate the runtime at a time.

release_sha="${1:-}"
image_archive="${2:-}"

if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "A full 40-character Git commit SHA is required." >&2
  exit 2
fi
if [[ "$image_archive" != "/tmp/cataloguer-backend-${release_sha}.tar.gz" || ! -f "$image_archive" ]]; then
  echo "The expected release archive is missing." >&2
  exit 2
fi

cd /opt/cataloguer
exec 9>/var/lock/cataloguer-deploy.lock
flock -n 9 || { echo "Another Cataloguer deployment is already running." >&2; exit 3; }

infra_env=".env.infrastructure"
new_image="cataloguer-backend:${release_sha}"
previous_image="$(sed -n 's/^BACKEND_IMAGE=//p' "$infra_env" | tail -n 1)"
rollback_env="$(mktemp /tmp/cataloguer-infrastructure.XXXXXX)"
cp "$infra_env" "$rollback_env"
compose=(docker compose --env-file "$infra_env")
backend_replaced=0

cleanup() {
  rm -f "$image_archive" "$rollback_env"
}

rollback() {
  local status=$?
  trap - ERR
  echo "Release failed; restoring application image ${previous_image}." >&2
  cp "$rollback_env" "$infra_env"
  if [[ "$backend_replaced" == "1" && -n "$previous_image" ]]; then
    "${compose[@]}" up -d --no-deps --force-recreate backend || true
  fi
  cleanup
  exit "$status"
}
trap rollback ERR
trap cleanup EXIT

echo "Loading immutable image ${new_image}..."
gzip -dc "$image_archive" | docker image load
docker image inspect "$new_image" >/dev/null

# Update only BACKEND_IMAGE; all runtime secrets remain untouched on the host.
awk -v image="$new_image" '
  BEGIN { changed=0 }
  /^BACKEND_IMAGE=/ { print "BACKEND_IMAGE=" image; changed=1; next }
  { print }
  END { if (!changed) print "BACKEND_IMAGE=" image }
' "$infra_env" > "${infra_env}.next"
chmod --reference="$infra_env" "${infra_env}.next"
mv "${infra_env}.next" "$infra_env"

"${compose[@]}" config --quiet
"${compose[@]}" up -d postgres

echo "Creating the pre-deployment database backup..."
bash ./backup-postgres.sh

echo "Applying pending database migrations with the new release image..."
"${compose[@]}" run --rm --no-deps backend node dist/jobs/migrate.main.js

echo "Replacing the backend..."
"${compose[@]}" up -d --no-deps --force-recreate backend
backend_replaced=1

container="$("${compose[@]}" ps -q backend)"
for _attempt in $(seq 1 60); do
  state="$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
  [[ "$state" == "healthy" ]] && break
  sleep 2
done
if [[ "${state:-missing}" != "healthy" ]]; then
  "${compose[@]}" logs --tail=150 backend
  echo "The new backend did not become healthy." >&2
  false
fi

curl --fail --silent --show-error --retry 5 --retry-delay 2 \
  "https://api.catalog.wegox.io/api/v1/health" >/dev/null

echo "Release ${release_sha} is healthy. Previous image: ${previous_image:-none}."
trap - ERR

# Keep the current image plus the two most recent local releases for manual
# rollback. Images in use are never removed.
mapfile -t stale_images < <(
  docker image ls cataloguer-backend --format '{{.CreatedAt}} {{.Repository}}:{{.Tag}}' |
    sort -r | awk 'NR > 3 { print $2 }'
)
if (( ${#stale_images[@]} )); then
  docker image rm "${stale_images[@]}" >/dev/null 2>&1 || true
fi

