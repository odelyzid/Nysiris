# Live-network acceptance test (needs the Nym toolchain + internet).
# shellcheck shell=bash
cmd_acceptance() {
  have cargo || die "cargo not found"

  local dir="$ROOT/services/acceptance"
  [[ -d "$dir" ]] || die "services/acceptance not found"

  if [[ "$INSTALL_TOOLS" == 1 ]]; then
    warn "the Nym toolchain is large; see services/acceptance/README.md"
    have rustup && { rustup toolchain install stable >/dev/null 2>&1 || true; }
  fi

  log "building acceptance harness (nym-sdk; first build is slow)"
  if ! (cd "$dir" && cargo build --release); then
    warn "could not build nym-sdk. See services/acceptance/README.md for install options"
    warn "(prebuilt binaries, cargo, or build from source)"
    [[ "$STRICT" == 1 ]] && die "acceptance build failed"
    return 0
  fi

  log "running live-network acceptance test"
  if ! (cd "$dir" && cargo run --release); then
    warn "acceptance run failed (network/toolchain?). See services/acceptance/README.md"
    [[ "$STRICT" == 1 ]] && die "acceptance failed"
    return 0
  fi

  ok "live-network acceptance passed"
}
