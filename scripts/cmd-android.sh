# Android packaging: Trusted Web Activity (preferred) or Capacitor.
# shellcheck shell=bash
cmd_android() {
  have node || die "node not found; install Node.js 20+"

  local web="$ROOT/web"
  local version="${APP_VERSION:-0.1.0}"

  if [[ "$INSTALL_TOOLS" == 1 ]]; then
    if have npm; then
      log "installing @bubblewrap/cli (TWA tooling)"
      npm install -g @bubblewrap/cli || warn "could not install bubblewrap"
    fi
    if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
      warn "ANDROID_HOME / ANDROID_SDK_ROOT not set; Capacitor/Gradle builds will need the Android SDK"
    fi
  fi

  # Preferred: Trusted Web Activity wrapping the deployed PWA. A missing
  # twa-manifest.json must NOT shadow the working Capacitor path below —
  # installing bubblewrap used to silently disable Android builds entirely.
  if have bubblewrap; then
    if [[ -f "$ROOT/twa-manifest.json" ]]; then
      log "building Trusted Web Activity with Bubblewrap"
      (cd "$ROOT" && bubblewrap build)
      ok "android (TWA) build complete"
      return 0
    fi
    warn "bubblewrap is installed but twa-manifest.json is missing; falling back to Capacitor"
    warn "  (initialise once with: bubblewrap init --manifest https://your.app/manifest.webmanifest)"
    [[ "$STRICT" == 1 ]] && die "twa-manifest.json missing"
  fi

  # Alternative: Capacitor native shell.
  if [[ -d "$web/android" ]]; then
    # The web build needs node_modules (vite/client types, etc.). A fresh
    # tagged-release checkout has none, which surfaces as:
    #   TS2688: Cannot find type definition file for 'vite/client'.
    # Install first, exactly like cmd_web does.
    if [[ "$NO_INSTALL" == 1 && ! -d "$web/node_modules" ]]; then
      die "web/node_modules missing and --no-install set; run ./build.sh web first (without --no-install)"
    fi
    if [[ "$NO_INSTALL" != 1 ]]; then
      log "installing web dependencies"
      if [[ -f "$web/package-lock.json" ]]; then
        (cd "$web" && npm ci)
      else
        (cd "$web" && npm install)
      fi
    fi

    log "building Capacitor Android project (web build + cap sync)"
    (cd "$web" && npm run android:sync)
    # `cap sync` copies the web bundle into app/src/main/assets/public and
    # regenerates the cordova-plugins module; gradle cannot run without both.
    if [[ ! -f "$web/android/app/src/main/assets/public/index.html" ]]; then
      die "cap sync produced no web assets (app/src/main/assets/public/index.html missing)"
    fi
    if [[ ! -x "$web/android/gradlew" ]]; then
      warn "gradlew not found in web/android; open the project in Android Studio"
      [[ "$STRICT" == 1 ]] && die "gradlew missing"
      return 0
    fi

    # Derive a monotonic versionCode from semver X.Y.Z so tagged releases
    # sort correctly on device / Play Store:
    #   code = major * 1000000 + minor * 1000 + patch
    local code=1 vname="$version"
    if [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
      code=$((10#${BASH_REMATCH[1]} * 1000000 + 10#${BASH_REMATCH[2]} * 1000 + 10#${BASH_REMATCH[3]}))
      [[ "$code" -lt 1 ]] && code=1
    else
      warn "APP_VERSION '$version' is not semver; using versionCode 1"
    fi
    local gradle_args=("-PandroidVersionCode=$code" "-PandroidVersionName=$vname")

    if [[ "$RELEASE" == 1 || "${ANDROID_RELEASE:-0}" == 1 ]]; then
      # Signing is opt-in via ANDROID_KEYSTORE_* (see android/README.md); the
      # gradle project reads the same variables. Fail loudly on a bad path and
      # say clearly when the output will be unsigned.
      local keystore="${ANDROID_KEYSTORE_PATH:-}"
      if [[ -n "$keystore" && ! -f "$keystore" ]]; then
        # Gradle resolves relative keystore paths against web/android/app;
        # match that here (and re-export the absolute path for gradle).
        if [[ -f "$web/android/app/$keystore" ]]; then
          ANDROID_KEYSTORE_PATH="$web/android/app/$keystore"
          export ANDROID_KEYSTORE_PATH
          keystore="$ANDROID_KEYSTORE_PATH"
        else
          die "ANDROID_KEYSTORE_PATH '$keystore' does not exist"
        fi
      fi
      if [[ -z "$keystore" ]]; then
        warn "no ANDROID_KEYSTORE_PATH configured: the release APK/AAB will be UNSIGNED (Android refuses to install it)"
        warn "  a debug-signed APK will also be staged as a sideloadable fallback"
      fi
      log "building Capacitor release APK + AAB (versionName $vname, versionCode $code)"
      local gradle_targets=(assembleRelease bundleRelease)
      if [[ -z "$keystore" ]]; then
        gradle_targets+=(assembleDebug)
      fi
      (cd "$web/android" && ./gradlew "${gradle_targets[@]}" "${gradle_args[@]}")
      local out="$ROOT/dist"
      mkdir -p "$out"
      local apk aab debug_apk staged=0
      apk="$(find "$web/android/app/build/outputs/apk/release" -maxdepth 1 -name '*.apk' -print | sort | head -n 1 || true)"
      aab="$(find "$web/android/app/build/outputs/bundle/release" -maxdepth 1 -name '*.aab' -print | sort | head -n 1 || true)"
      if [[ -n "$apk" ]]; then
        cp "$apk" "$out/nysiris_${version}_android.apk"
        log "staged dist/nysiris_${version}_android.apk"
        if [[ "$(basename "$apk")" == *unsigned* ]]; then
          warn "the staged release APK is UNSIGNED — sideload the -debug APK instead"
        fi
        staged=1
      fi
      if [[ -n "$aab" ]]; then
        cp "$aab" "$out/nysiris_${version}_android.aab"
        log "staged dist/nysiris_${version}_android.aab"
        staged=1
      fi
      if [[ -z "$keystore" ]]; then
        debug_apk="$(find "$web/android/app/build/outputs/apk/debug" -maxdepth 1 -name '*.apk' -print | sort | head -n 1 || true)"
        if [[ -n "$debug_apk" ]]; then
          cp "$debug_apk" "$out/nysiris_${version}_android-debug.apk"
          log "staged dist/nysiris_${version}_android-debug.apk (debug-signed, installable)"
        fi
      fi
      [[ "$staged" == 1 ]] || die "gradle release build produced no APK/AAB"
      ok "android (Capacitor) release build complete"
    else
      log "building Capacitor debug APK (versionName $vname, versionCode $code)"
      (cd "$web/android" && ./gradlew assembleDebug "${gradle_args[@]}")
      ok "android (Capacitor) debug APK built"
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

  Release (tagged) build:
      ./build.sh android --release   # signs when ANDROID_KEYSTORE_* is set
                                     # (see android/README.md); otherwise the
                                     # release output is unsigned and a
                                     # debug-signed APK is staged as fallback

  See android/README.md for manifest, network-security-config and background
  execution notes.
EOF

  [[ "$STRICT" == 1 ]] && die "android build unavailable"
  return 0
}
