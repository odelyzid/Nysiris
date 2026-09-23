# Windows package: launcher + bundled PWA + Nysiris.bat, zipped for download.
# MSYS2/MinGW or MSVC both work; see docs/12-windows.md for setup.
# Output: dist/nysiris_<version>_windows-<arch>.zip
# shellcheck shell=bash
cmd_windows() {
  # rustup installs cargo into the native Windows profile (USERPROFILE); a
  # bare MSYS2/MINGW64 shell PATH (and its MSYS2-style $HOME) does not include
  # it. Prefer CARGO_HOME, then the native profile, then the MSYS2 $HOME.
  if ! have cargo; then
    local c
    local -a candidates=()
    [[ -n "$CARGO_HOME" ]] && candidates+=("$CARGO_HOME/bin")
    [[ -n "$USERPROFILE" ]] && candidates+=("$USERPROFILE/.cargo/bin")
    candidates+=("$HOME/.cargo/bin")
    for c in "${candidates[@]}"; do
      # MSYS bash resolves .exe for `command -v`/`-x` only through MSYS-style
      # paths (/c/...), so normalize the Windows-style profile path.
      if have cygpath; then c="$(cygpath -u "$c" 2>/dev/null || printf '%s' "$c")"; fi
      if [[ -x "$c/cargo" || -x "$c/cargo.exe" ]]; then
        PATH="$c:$PATH"
        export PATH
        break
      fi
    done
  fi
  have cargo || die "cargo not found; install Rust via https://rustup.rs (on MSYS2: pacman -S mingw-w64-x86_64-toolchain)"

  local version="${APP_VERSION:-0.1.0}"
  local target="$TARGET"
  if [[ -z "$target" ]]; then
    case "$(uname -s 2>/dev/null || echo unknown)" in
      MINGW* | MSYS* | CYGWIN*) target="x86_64-pc-windows-gnu" ;;
      *)
        die "cross-compiling to Windows from here needs --target (e.g. --target x86_64-pc-windows-gnu, plus its linker)"
        ;;
    esac
  fi
  local arch="x86_64"
  [[ "$target" == aarch64-* ]] && arch="aarch64"

  if [[ "$INSTALL_TOOLS" == 1 ]]; then
    if have rustup; then
      log "adding rust target $target"
      rustup target add "$target"
    else
      warn "rustup unavailable; ensure the $target toolchain is installed"
    fi
  fi

  if [[ ! -f "$ROOT/web/dist/index.html" ]]; then
    if [[ "$NO_INSTALL" == 1 ]]; then
      die "web/dist missing and --no-install set; run ./build.sh web first"
    fi
    log "web/dist missing; building the web app first"
    cmd_web
  fi

  log "building launcher for $target (release)"
  (cd "$ROOT" && cargo build -p nysiris-launcher --release --target "$target")
  local exe="$ROOT/target/$target/release/nysiris-launcher.exe"
  [[ -x "$exe" ]] || die "launcher binary missing at $exe"

  local stage_name="nysiris_${version}_windows-${arch}"
  local stage="$ROOT/dist/windows/$stage_name"
  log "staging package tree at ${stage#"$ROOT"/}"
  rm -rf "$stage"
  mkdir -p "$stage/web"
  cp "$exe" "$stage/nysiris-launcher.exe"
  cp -r "$ROOT/web/dist/." "$stage/web/"
  # Source maps account for ~half the build size and are not needed in a
  # download; developers can rebuild with `./build.sh web`.
  find "$stage/web" -type f -name '*.map' -delete
  cp "$ROOT/desktop/windows/Nysiris.bat" "$stage/Nysiris.bat"
  cp "$ROOT/desktop/windows/README.txt" "$stage/README.txt"

  local zip="$ROOT/dist/nysiris_${version}_windows-${arch}.zip"
  if have powershell.exe; then
    log "zipping with Compress-Archive"
    (cd "$ROOT/dist/windows" && rm -f "$zip" && powershell.exe -NoProfile -NonInteractive -Command "Compress-Archive -Path '$stage_name' -DestinationPath '$(basename "$zip")' -Force")
  elif have zip; then
    log "zipping with zip"
    (cd "$ROOT/dist/windows" && rm -f "$zip" && zip -qr "$(basename "$zip")" "$stage_name")
  else
    die "need powershell.exe (Windows) or zip to package; stage left at ${stage#"$ROOT"/}"
  fi

  ok "windows package built: ${zip#"$ROOT"/}"
}
