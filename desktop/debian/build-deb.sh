#!/usr/bin/env bash
#
# Build a Debian package (.deb) for Linux Mint / Debian / Ubuntu.
#
#   ./desktop/debian/build-deb.sh [VERSION]
#
# Requires `web/dist` to exist (build it with `./build.sh web`) and dpkg-deb.
# Output: dist/fly-protocol_<version>_<arch>.deb
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../scripts/lib.sh
source "$ROOT/scripts/lib.sh"

VERSION="${1:-0.1.0}"
ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
DIST="$ROOT/web/dist"
STAGE="$ROOT/desktop/build/fly-protocol_${VERSION}_${ARCH}"
OUT="$ROOT/dist"
BIN="$ROOT/target/release/fly-protocol-launcher"

have dpkg-deb || die "dpkg-deb not found; this packaging path targets Debian-based distros"

if [[ ! -f "$DIST/index.html" ]]; then
    die "web/dist/index.html not found. Build the web app first: ./build.sh web"
fi

log "building launcher (release)"
(cd "$ROOT" && cargo build -p fly-protocol-launcher --release)
[[ -x "$BIN" ]] || die "launcher binary missing at $BIN"

log "staging package tree at ${STAGE#"$ROOT"/}"
rm -rf "$STAGE"
install -d \
    "$STAGE/DEBIAN" \
    "$STAGE/usr/bin" \
    "$STAGE/usr/lib/fly-protocol/web" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/scalable/apps" \
    "$STAGE/usr/share/doc/fly-protocol"

install -m 0755 "$BIN" "$STAGE/usr/lib/fly-protocol/fly-protocol-launcher"
cp -r "$DIST/." "$STAGE/usr/lib/fly-protocol/web/"
# Source maps account for ~half the build size and are not needed in a distro
# package; developers can rebuild with `./build.sh web`.
find "$STAGE/usr/lib/fly-protocol/web" -type f -name '*.map' -delete
install -m 0755 "$ROOT/desktop/debian/fly-protocol" "$STAGE/usr/bin/fly-protocol"
install -m 0644 "$ROOT/desktop/debian/fly-protocol.desktop" \
    "$STAGE/usr/share/applications/fly-protocol.desktop"
install -m 0644 "$ROOT/desktop/debian/fly-protocol.svg" \
    "$STAGE/usr/share/icons/hicolor/scalable/apps/fly-protocol.svg"
install -m 0755 "$ROOT/desktop/debian/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$ROOT/desktop/debian/prerm" "$STAGE/DEBIAN/prerm"

SIZE_KB="$(du -sk "$STAGE" | cut -f1)"
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@SIZE@/$SIZE_KB/" \
    "$ROOT/desktop/debian/control.in" > "$STAGE/DEBIAN/control"

mkdir -p "$OUT"
DEB="$OUT/fly-protocol_${VERSION}_${ARCH}.deb"
log "building $DEB"
dpkg-deb --build --root-owner-group "$STAGE" "$DEB" >/dev/null

ok "package built: ${DEB#"$ROOT"/}"
dpkg-deb --info "$DEB" | sed 's/^/  /'
