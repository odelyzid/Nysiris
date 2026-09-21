# Standalone service crates (require the Nym toolchain; heavy first build).
# Release profile by default: these are deployment artifacts; see each
# service README for its run instructions. Honors --target and --skip-tests.
# Optional positional filter builds/tests just one crate:
#   ./build.sh services social
# shellcheck shell=bash
cmd_services() {
  have cargo || die "cargo not found"

  local args=(--locked --release)
  if [[ -n "$TARGET" ]]; then
    if [[ "$INSTALL_TOOLS" == 1 ]]; then
      if have rustup; then
        log "adding rust target $TARGET"
        rustup target add "$TARGET"
      else
        warn "rustup unavailable; ensure the $TARGET toolchain is installed"
      fi
    fi
    args+=(--target "$TARGET")
  fi

  local filter="${SERVICE_FILTER:-}"
  local built=0 tested=0
  while IFS= read -r manifest; do
    local dir name
    dir="$(dirname "$manifest")"
    name="$(basename "$dir")"
    if [[ -n "$filter" && "$name" != "$filter" ]]; then
      continue
    fi
    log "building service: ${dir#"$ROOT"/}"
    (cd "$dir" && cargo build "${args[@]}") || die "service build failed: $name"
    built=$((built + 1))
    if [[ "$SKIP_TESTS" != 1 ]]; then
      log "testing service: ${dir#"$ROOT"/}"
      (cd "$dir" && cargo test "${args[@]}") || die "service tests failed: $name"
      tested=$((tested + 1))
    fi
  done < <(find "$ROOT/services" -maxdepth 2 -name Cargo.toml -print | sort)

  [[ "$built" -gt 0 ]] || die "no service crates found under services/ (filter: '${filter:-none}')"
  ok "built $built service crate(s), tested $tested"
}
