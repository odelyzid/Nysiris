#!/usr/bin/env bash
# Verify ZERO clearnet exposure for the mixnet-only hybrid stack.
# Fails closed: any published port, any host listener on 80/443, or any
# reachable clearnet path => exit 1.
#
# Usage:
#   ./verify-no-clearnet.sh [compose-file]
# Example:
#   ./verify-no-clearnet.sh docker-compose.mixnet-only.yml
set -euo pipefail
FILE="${1:-docker-compose.mixnet-only.yml}"
cd "$(dirname "$0")"

echo "== 1. compose file publishes no ports =="
if grep -Eq '^\s*ports\s*:' "$FILE"; then
  echo "FAIL: $FILE contains a ports: stanza (clearnet surface)"
  grep -n 'ports' "$FILE"
  exit 1
fi
echo "ok: no ports: in $FILE"

echo "== 2. no caddy / clearnet front door =="
# Strip comments: only service definitions count, not documentation.
if grep -Ev '^\s*#' "$FILE" | grep -Eq '^\s{2}(caddy|traefik|haproxy|nginx|apache):\s*$'; then
  echo "FAIL: clearnet reverse-proxy service detected in $FILE"
  exit 1
fi
echo "ok: no clearnet proxy service"

echo "== 3. backend network is internal =="
if ! grep -Eq 'internal:\s*true' "$FILE"; then
  echo "FAIL: no internal:true network in $FILE"
  exit 1
fi
echo "ok: internal network present"

echo "== 4. running containers expose no host ports (if stack is up) =="
if docker compose -f "$FILE" ps -q 2>/dev/null | grep -q .; then
  if docker compose -f "$FILE" ps --format json 2>/dev/null | grep -Eq '"Publishers":\s*\[[^]]*[0-9]'; then
    echo "FAIL: a running container publishes host ports"
    docker compose -f "$FILE" ps
    exit 1
  fi
  echo "ok: running containers publish nothing"
else
  echo "skip: stack not running (start it to check live state)"
fi

echo "== 5. host is not listening on 80/443 =="
if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq ':(80|443)$'; then
  echo "FAIL: host listens on 80/443"
  ss -tlnp | grep -E ':(80|443)\b' || true
  exit 1
fi
echo "ok: host has no 80/443 listener"

echo "== 6. backend not reachable from host network =="
if curl -sm 3 http://127.0.0.1:80/ >/dev/null 2>&1; then
  echo "FAIL: something answers on 127.0.0.1:80"
  exit 1
fi
if curl -sm 3 http://127.0.0.1:443/ -k >/dev/null 2>&1; then
  echo "FAIL: something answers on 127.0.0.1:443"
  exit 1
fi
echo "ok: no clearnet HTTP(S) on loopback"

echo
echo "PASS: no clearnet surface detected."
echo "Mixnet path is unaffected: bridge dials OUT (WSS) to its gateway."
