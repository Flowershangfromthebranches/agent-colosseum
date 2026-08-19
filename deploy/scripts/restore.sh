#!/usr/bin/env bash
set -euo pipefail
FILE="${1:?usage: restore.sh <dump.sql>}"
docker compose -f "$(dirname "$0")/../docker-compose.yml" exec -T postgres \
  psql -U arena -d arena < "$FILE"
echo "restored $FILE"
