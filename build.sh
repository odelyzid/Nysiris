#!/usr/bin/env bash
#
# nysiris build entry point.
#
#   ./build.sh rust              # compile + test the Rust workspace
#   ./build.sh rust --release    # optimized build
#   ./build.sh rust --target aarch64-unknown-linux-gnu
#   ./build.sh web               # install deps + build the browser PWA
#   ./build.sh android           # TWA (Bubblewrap) or Capacitor APK/AAB (--release for signed-release staging)
#   ./build.sh services [name]  # build + test the standalone Nym service crates
#                            # (optional: just one, e.g. `services social`)
#   ./build.sh check             # fmt + clippy + tests + web tests + docs
#   ./build.sh desktop           # Linux .deb (system Chromium)
#   ./build.sh windows           # Windows zip (MSYS2/MinGW or MSVC)
#   ./build.sh all               # rust + check + web
#   ./build.sh clean [--deep]    # remove build artifacts
#
# Flags:
#   --release         build with optimizations
#   --target TRIPLE   cross-compile the Rust workspace for TRIPLE
#   --install-tools   try to install missing toolchain pieces
#   --no-install      skip npm install (web build only)
#   --skip-tests      skip cargo test/clippy (rust command only)
#   --strict          treat "tool unavailable" as a failure
#   --deep            (clean) also remove node_modules
#   -h, --help        show this help
#
set -euo pipefail

# Resolve the repo root from this file's location, following symlinks, so the
# scripts keep working when the repo folder is moved/renamed or invoked
# through a link (e.g. ~/bin/build.sh -> <repo>/build.sh) and from any cwd.
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")" && pwd)"
export ROOT
unset SOURCE DIR

# shellcheck source=scripts/lib.sh
source "$ROOT/scripts/lib.sh"

RELEASE=0
TARGET=""
STRICT=0
INSTALL_TOOLS=0
NO_INSTALL=0
SKIP_TESTS=0
CLEAN_DEEP=0
DESKTOP_ELECTRON=0
SERVICE_FILTER=""
APP_VERSION=""
BUMP_PART=""
COMMAND=""

usage() {
  cat <<'EOF'
nysiris build entry point.

  ./build.sh rust              # compile + test the Rust workspace
  ./build.sh rust --release    # optimized build
  ./build.sh rust --target aarch64-unknown-linux-gnu
  ./build.sh wasm              # compile sphinx-core to wasm32 (optional)
  ./build.sh web               # install deps + build the browser PWA
  ./build.sh android           # TWA (Bubblewrap) or Capacitor APK/AAB
  ./build.sh services [name]  # build + test the standalone Nym service crates
  ./build.sh soak              # heavy parser/route soak (SPHINX_SOAK_ITERS=5000)
  ./build.sh acceptance        # live-network test (needs the Nym toolchain)
  ./build.sh desktop           # Linux .deb (system Chromium); --electron for Electron
  ./build.sh windows           # Windows zip (MSYS2/MinGW or MSVC); see docs/12-windows.md
  ./build.sh check             # fmt + clippy + tests + web tests + docs
  ./build.sh all               # rust + check + web
  ./build.sh bump patch        # bump the version (major|minor|patch|X.Y.Z)
  ./build.sh clean [--deep]    # remove build artifacts

Flags:
  --release         build with optimizations
  --target TRIPLE   cross-compile the Rust workspace for TRIPLE
  --install-tools   try to install missing toolchain pieces
  --no-install      skip npm install (web build only)
  --skip-tests      skip cargo test/clippy (rust command only)
  --strict          treat "tool unavailable" as a failure
  --deep            (clean) also remove node_modules
  --electron        (desktop) build the Electron package instead of the .deb
  --app-version V   package version (default: contents of ./VERSION)
  -v, --verbose     echo commands
  -h, --help        show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    rust | wasm | web | android | services | soak | acceptance | desktop | windows | check | all | clean | bump)
      COMMAND="$1"; shift ;;
    --release) RELEASE=1; shift ;;
    --target) TARGET="${2:?--target requires a value}"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --install-tools) INSTALL_TOOLS=1; shift ;;
    --no-install) NO_INSTALL=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --deep) CLEAN_DEEP=1; shift ;;
    --electron) DESKTOP_ELECTRON=1; shift ;;
    --app-version) APP_VERSION="${2:?--app-version requires a value}"; shift 2 ;;
    -v | --verbose) set -x; shift ;;
    -h | --help) usage; exit 0 ;;
    *)
      # `bump` takes an optional version part as a positional argument,
      # `services` an optional crate name filter.
      if [[ "$COMMAND" == "bump" && -z "$BUMP_PART" && "$1" != -* ]]; then
        BUMP_PART="$1"; shift
      elif [[ "$COMMAND" == "services" && -z "$SERVICE_FILTER" && "$1" != -* ]]; then
        SERVICE_FILTER="$1"; shift
      else
        die "unknown argument: $1 (try --help)"
      fi
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi

# App version: --app-version wins, otherwise the single source of truth ./VERSION.
if [[ -z "$APP_VERSION" ]]; then
  APP_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
fi

export RELEASE TARGET STRICT INSTALL_TOOLS NO_INSTALL SKIP_TESTS CLEAN_DEEP DESKTOP_ELECTRON APP_VERSION BUMP_PART SERVICE_FILTER

# shellcheck source=scripts/cmd-rust.sh
source "$ROOT/scripts/cmd-rust.sh"
# shellcheck source=scripts/cmd-web.sh
source "$ROOT/scripts/cmd-web.sh"
# shellcheck source=scripts/cmd-android.sh
source "$ROOT/scripts/cmd-android.sh"
# shellcheck source=scripts/cmd-services.sh
source "$ROOT/scripts/cmd-services.sh"
# shellcheck source=scripts/cmd-check.sh
source "$ROOT/scripts/cmd-check.sh"
# shellcheck source=scripts/cmd-soak.sh
source "$ROOT/scripts/cmd-soak.sh"
# shellcheck source=scripts/cmd-acceptance.sh
source "$ROOT/scripts/cmd-acceptance.sh"
# shellcheck source=scripts/cmd-desktop.sh
source "$ROOT/scripts/cmd-desktop.sh"
# shellcheck source=scripts/cmd-windows.sh
source "$ROOT/scripts/cmd-windows.sh"
# shellcheck source=scripts/cmd-bump.sh
source "$ROOT/scripts/cmd-bump.sh"

case "$COMMAND" in
  rust) section "Rust build"; cmd_rust ;;
  wasm) section "Rust -> WASM"; cmd_rust_wasm ;;
  web) section "Web build"; cmd_web ;;
  android) section "Android build"; cmd_android ;;
  services) section "Service crates"; cmd_services ;;
  soak) section "Soak test"; cmd_soak ;;
  acceptance) section "Live-network acceptance"; cmd_acceptance ;;
  desktop) section "Desktop build"; cmd_desktop ;;
  windows) section "Windows package"; cmd_windows ;;
  bump) section "Bump version"; cmd_bump ;;
  check) section "Checks"; cmd_check ;;
  all)
    section "Rust build"; cmd_rust
    section "Checks"; cmd_check
    section "Web build"; cmd_web
    ;;
  clean) section "Clean"; cmd_clean ;;
esac
