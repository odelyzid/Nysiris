# Rust target compilation.
# shellcheck shell=bash
cmd_rust() {
  have cargo || die "cargo not found; install Rust via https://rustup.rs"

  local args=(--workspace)
  [[ "$RELEASE" == 1 ]] && args+=(--release)

  if [[ -n "$TARGET" ]]; then
    if [[ "$INSTALL_TOOLS" == 1 ]]; then
      if have rustup; then
        log "adding rust target $TARGET"
        rustup target add "$TARGET"
      else
        warn "rustup unavailable; ensure the $TARGET toolchain is installed"
      fi
    fi
    log "cargo build --workspace --target $TARGET"
    cargo build "${args[@]}" --target "$TARGET"
    ok "built workspace for target $TARGET"
    return 0
  fi

  log "cargo build --workspace"
  cargo build "${args[@]}"

  if [[ "$SKIP_TESTS" != 1 ]]; then
    log "cargo test --workspace"
    cargo test --workspace
    log "cargo clippy --workspace --all-targets -- -D warnings"
    cargo clippy --workspace --all-targets -- -D warnings
  fi

  ok "rust build complete"
}

# Compile the reference core to WebAssembly (optional browser-side artifact).
# Requires the wasm32 target; wasm-pack is used only if present.
cmd_rust_wasm() {
  have cargo || die "cargo not found"
  if [[ "$INSTALL_TOOLS" == 1 ]]; then
    have rustup && rustup target add wasm32-unknown-unknown
    have wasm-pack || cargo install wasm-pack
  fi
  log "cargo build -p sphinx-core --target wasm32-unknown-unknown"
  cargo build -p sphinx-core --release --target wasm32-unknown-unknown || {
    warn "wasm32 target not installed? run: rustup target add wasm32-unknown-unknown"
    [[ "$STRICT" == 1 ]] && die "wasm build failed"
    return 0
  }
  ok "wasm artifact at target/wasm32-unknown-unknown/release/"
}
