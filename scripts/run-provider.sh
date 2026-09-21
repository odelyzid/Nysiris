#!/usr/bin/env bash
#
# Run a Nym hidden-service provider with sane defaults.
#
#   scripts/run-provider.sh [portal|social|echo] [--build] [--no-build]
#
# Defaults to the portal provider. Already-exported environment variables win
# over the defaults below, so every knob stays overridable:
#
#   SP_DATA_DIR=./sp-storage            persistent keys => stable Nym address
#   SP_GATEWAY=<gateway-identity-key>   optional pin for a stable address
#   portal:  PORTAL_DB=./portal.sqlite  PORTAL_POW_BITS=0  PORTAL_RATE_PER_DAY=500
#   social:  SOCIAL_DB=./social.sqlite  SOCIAL_POW_BITS=0  SOCIAL_RATE_PER_DAY=500
#   echo:    (no database, no rate limits)
#
# The provider prints its Nym address on startup and writes it to
# <service-dir>/nym-address.txt. No inbound ports: it only dials out to its
# entry gateway. Back up the data dir (identity) and the sqlite file (data).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SERVICE="portal"
BUILD_MODE="auto" # auto | force | skip

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    portal | social | echo) SERVICE="$1"; shift ;;
    --build) BUILD_MODE="force"; shift ;;
    --no-build) BUILD_MODE="skip"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "fail unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
done

case "$SERVICE" in
  portal) DIR="portal-provider"; BIN="portal-provider"; DB_VAR="PORTAL_DB"; DB_DEFAULT="./portal.sqlite" ;;
  social) DIR="social"; BIN="fly-social"; DB_VAR="SOCIAL_DB"; DB_DEFAULT="./social.sqlite" ;;
  echo) DIR="echo-provider"; BIN="echo-provider"; DB_VAR=""; DB_DEFAULT="" ;;
esac

SVC_DIR="$ROOT/services/$DIR"
BINARY="$SVC_DIR/target/release/$BIN"

[[ -d "$SVC_DIR" ]] || { echo "fail service directory not found: $SVC_DIR" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "fail cargo not found" >&2; exit 1; }

if [[ "$BUILD_MODE" == "force" || ("$BUILD_MODE" == "auto" && ! -x "$BINARY") ]]; then
  echo "==> building $BIN (release, locked)"
  (cd "$SVC_DIR" && cargo build --locked --release)
fi
[[ -x "$BINARY" ]] || {
  echo "fail $BINARY not found; run with --build first" >&2
  exit 1
}

# Persistent identity storage. Lose this directory and the Nym address is gone.
export SP_DATA_DIR="${SP_DATA_DIR:-./sp-storage}"
if [[ "$SP_DATA_DIR" = /* ]]; then
  mkdir -p "$SP_DATA_DIR"
else
  mkdir -p "$SVC_DIR/$SP_DATA_DIR"
fi

if [[ -n "$DB_VAR" ]]; then
  # shellcheck disable=SC2086
  export "$DB_VAR"="${!DB_VAR:-$DB_DEFAULT}"
fi

if [[ -z "${SP_GATEWAY:-}" ]]; then
  echo "==> SP_GATEWAY unset: using the gateway stored in $SP_DATA_DIR (pin one for a guaranteed-stable address)"
else
  echo "==> pinning provider to gateway $SP_GATEWAY"
fi

# New files (identity keys, sqlite db) are created owner-only.
umask 077

echo "==> starting $SERVICE provider from $SVC_DIR"
echo "==> address will be printed below and written to $SVC_DIR/nym-address.txt"
cd "$SVC_DIR"
exec "$BINARY"
