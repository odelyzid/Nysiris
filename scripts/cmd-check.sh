# Fast local verification. Runs without network access where possible.
# shellcheck shell=bash
cmd_check() {
  have cargo || die "cargo not found"

  section "Rust: formatting"
  cargo fmt --all -- --check
  ok "rustfmt clean"

  section "Rust: lints"
  cargo clippy --workspace --all-targets -- -D warnings
  ok "clippy clean"

  section "Rust: tests"
  cargo test --workspace
  ok "workspace tests pass"

  section "Services: manifests"
  local manifests=0
  while IFS= read -r manifest; do
    (cd "$(dirname "$manifest")" && cargo metadata --format-version 1 --no-deps >/dev/null) \
      || die "service manifest invalid: $manifest"
    manifests=$((manifests + 1))
  done < <(find "$ROOT/services" -maxdepth 2 -name Cargo.toml -print | sort)
  [[ "$manifests" -gt 0 ]] || die "no service crates found under services/"
  ok "service manifests parse ($manifests crates; full builds: ./build.sh services)"

  if have node; then
    section "Web: pure-logic tests"
    local tests=()
    if [[ -d "$ROOT/web/test" ]]; then
      while IFS= read -r f; do tests+=("$f"); done < <(find "$ROOT/web/test" -name '*.test.mjs' -print | sort)
    fi
    if [[ ${#tests[@]} -gt 0 ]]; then
      node --test "${tests[@]}"
      ok "web unit tests pass"
    else
      warn "no web tests found"
    fi

    section "Manifests + docs"
    node "$ROOT/scripts/check-json.mjs"
    node "$ROOT/scripts/check-docs.mjs"
    ok "manifests and doc links valid"
  else
    warn "node not found; skipping web/json/doc checks"
  fi

  section "Result"
  ok "all checks passed"
}

# Remove build artifacts. `--deep` also removes node_modules.
# shellcheck shell=bash
cmd_clean() {
  log "cargo clean"
  (cd "$ROOT" && cargo clean) || true

  log "removing web/dist"
  rm -rf "$ROOT/web/dist"

  log "removing service build outputs"
  find "$ROOT/services" -maxdepth 2 -name target -type d -prune -exec rm -rf {} +

  if [[ "${CLEAN_DEEP:-0}" == 1 ]]; then
    warn "removing web/node_modules and android build outputs"
    rm -rf "$ROOT/web/node_modules" "$ROOT/web/android/app/build" "$ROOT/web/android/build"
  fi

  ok "clean complete"
}
