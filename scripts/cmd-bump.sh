# Version bumping. Single source of truth is ./VERSION.
# shellcheck shell=bash
cmd_bump() {
  local part="${BUMP_PART:-patch}"
  local current next
  current="$(cat "$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"

  if [[ "$part" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    next="$part"
  else
    local major minor patch
    IFS=. read -r major minor patch <<<"$current"
    case "$part" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) die "usage: ./build.sh bump [major|minor|patch|X.Y.Z]" ;;
    esac
    next="$major.$minor.$patch"
  fi

  if [[ "$current" == "$next" ]]; then
    warn "version is already $next"
    return 0
  fi

  log "bumping $current -> $next"
  printf '%s\n' "$next" > "$ROOT/VERSION"

  # Keep the JS manifests in step (no install needed for `npm pkg set`).
  if have node; then
    (cd "$ROOT/web" && npm pkg set version="$next" >/dev/null)
    (cd "$ROOT/desktop/electron" && npm pkg set version="$next" >/dev/null)
    ok "updated VERSION, web/package.json, desktop/electron/package.json"
  else
    warn "node not found; only ./VERSION was updated"
  fi

  echo
  echo "Next:"
  echo "  ./build.sh desktop                      # system-Chromium .deb ($next)"
  echo "  ./build.sh desktop --electron           # Electron .deb + AppImage"
  echo "  ./build.sh web && ./build.sh android    # PWA / Android"
  echo "  ./build.sh check                        # verify"
}
