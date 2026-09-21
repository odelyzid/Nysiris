# Desktop build: system-Chromium `.deb` (or Electron).
# shellcheck shell=bash
cmd_desktop() {
  have cargo || die "cargo not found"

  if [[ "${DESKTOP_ELECTRON:-0}" == 1 ]]; then
    have npm || die "npm not found (required for the Electron path)"
    if [[ ! -f "$ROOT/web/dist/index.html" ]]; then
      log "web/dist missing; building the web app first"
      cmd_web
    fi
    mkdir -p "$ROOT/desktop/electron/web"
    cp -r "$ROOT/web/dist/." "$ROOT/desktop/electron/web/"
    if [[ -n "${APP_VERSION:-}" ]]; then
      log "setting Electron package version to $APP_VERSION"
      (cd "$ROOT/desktop/electron" && npm pkg set version="$APP_VERSION")
    fi
    log "building Electron package (deb + AppImage)"
    (cd "$ROOT/desktop/electron" && npm install && npm run dist)
    ok "electron artifacts in desktop/electron/dist"
    return 0
  fi

  if [[ ! -f "$ROOT/web/dist/index.html" ]]; then
    if [[ "$NO_INSTALL" == 1 ]]; then
      die "web/dist missing and --no-install set; run ./build.sh web first"
    fi
    log "web/dist missing; building the web app first"
    cmd_web
  fi

  bash "$ROOT/desktop/debian/build-deb.sh" "${APP_VERSION:-0.1.0}"
}
