# Heavy parser/route soak test (release mode). Not part of `check`.
# shellcheck shell=bash
cmd_soak() {
  have cargo || die "cargo not found"

  local iters="${SPHINX_SOAK_ITERS:-5000}"
  local seed="${SPHINX_SOAK_SEED:-}"
  local seed_args=()
  [[ -n "$seed" ]] && seed_args=(SPHINX_SOAK_SEED="$seed")

  log "soak: cargo test -p sphinx-core --release --test soak (iterations=$iters)"
  # The soak test is #[ignore]d so it never runs during `check`.
  env SPHINX_SOAK_ITERS="$iters" "${seed_args[@]}" \
    cargo test -p sphinx-core --release --test soak -- --ignored --nocapture
  ok "soak complete ($iters iterations)"
}
