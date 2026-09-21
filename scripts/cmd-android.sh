# Android packaging: Trusted Web Activity (preferred) or Capacitor.
# shellcheck shell=bash
cmd_android() {
  have node || die "node not found; install Node.js 20+"

  local web="$ROOT/web"

  if [[ "$INSTALL_TOOLS" == 1 ]]; then
    if have npm; then
      log "installing @bubblewrap/cli (TWA tooling)"
      npm install -g @bubblewrap/cli || warn "could not install bubblewrap"
    fi
    if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
      warn "ANDROID_HOME / ANDROID_SDK_ROOT not set; Capacitor/Gradle builds will need the Android SDK"
    fi
  fi

  # Preferred: Trusted Web Activity wrapping the deployed PWA.
  if have bubblewrap; then
    log "building Trusted Web Activity with Bubblewrap"
    if [[ ! -f "$ROOT/twa-manifest.json" ]]; then
      warn "twa-manifest.json not found; initialise once with:"
      warn "  bubblewrap init --manifest https://your.app/manifest.webmanifest"
      [[ "$STRICT" == 1 ]] && die "twa-manifest.json missing"
      return 0
    fi
    (cd "$ROOT" && bubblewrap build)
    ok "android (TWA) build complete"
    return 0
  fi

  # Alternative: Capacitor native shell.
  if [[ -d "$web/android" ]]; then
    log "building Capacitor Android project"
    (cd "$web" && npm run android:sync)
    if [[ -x "$web/android/gradlew" ]]; then
      (cd "$web/android" && ./gradlew assembleDebug)
      ok "android (Capacitor) debug APK built"
    else
      warn "gradlew not found in web/android; open the project in Android Studio"
    fi
    return 0
  fi

  warn "no Android toolchain detected (neither bubblewrap nor a Capacitor android/ project)"
  cat <<'EOF'

  Install one of:

    TWA (recommended):
      npm install -g @bubblewrap/cli
      (cd web && npm run build)
      bubblewrap init --manifest https://your.app/manifest.webmanifest
      ./build.sh android

    Capacitor:
      (cd web && npm run build && npx cap add android)
      ./build.sh android

  See android/README.md for manifest, network-security-config and background
  execution notes.
EOF

  [[ "$STRICT" == 1 ]] && die "android build unavailable"
  return 0
}
