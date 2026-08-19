#!/usr/bin/env bash
set -euo pipefail
# Roll back the arena service to the previous local image tag.
IMAGE="${1:-agent-colosseum-arena:previous}"
docker tag agent-colosseum-arena:latest "$IMAGE.failed" || true
docker tag "$IMAGE" agent-colosseum-arena:latest
docker compose -f "$(dirname "$0")/../docker-compose.yml" up -d arena
"$(dirname "$0")/health.sh" "${2:-http://127.0.0.1:8787}"
