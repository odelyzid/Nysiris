# Shared helpers for the nysiris build scripts.
# Sourced by build.sh; not meant to be run directly.
# shellcheck shell=bash

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'
else
  C_RESET=; C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=; C_BOLD=
fi

log()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%sfail%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Print a section banner only when not quiet.
section() {
  printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"
}
