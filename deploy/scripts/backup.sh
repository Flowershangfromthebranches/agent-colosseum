#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-./backups/arena-$(date -u +%Y%m%dT%H%M%SZ).sql}"
mkdir -p "$(dirname "$OUT")"
docker compose -f "$(dirname "$0")/../docker-compose.yml" exec -T postgres \
  pg_dump -U arena -d arena --no-owner --format=plain > "$OUT"
echo "wrote $OUT"
