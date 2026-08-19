#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:8787}"
curl -fsS "$BASE/healthz" | grep -q '"ok":true'
curl -fsS "$BASE/readyz" | grep -q '"ok":true'
echo "healthy"
