# Browser (PWA) build.
# shellcheck shell=bash
cmd_web() {
  have node || die "node not found; install Node.js 20+"

  local dir="$ROOT/web"

  if [[ "$NO_INSTALL" == 1 && ! -d "$dir/node_modules" ]]; then
    warn "web/node_modules missing and --no-install set; skipping the web build and tests"
    return 0
  fi

  # Install first: crypto-vector tests import @noble from node_modules, so
  # running them before npm ci would silently skip the entire shop suite.
  if [[ "$NO_INSTALL" != 1 ]]; then
    log "installing web dependencies"
    if [[ -f "$dir/package-lock.json" ]]; then
      (cd "$dir" && npm ci)
    else
      (cd "$dir" && npm install)
    fi
  fi

  if [[ -d "$dir/test" ]]; then
    local tests=()
    while IFS= read -r f; do tests+=("$f"); done < <(find "$dir/test" -name '*.test.mjs' -print | sort)
    if [[ ${#tests[@]} -gt 0 ]]; then
      log "browser unit tests (node --test)"
      node --test "${tests[@]}"
    fi
  fi

  log "building web app"
  (cd "$dir" && npm run build)
  ok "web build complete -> web/dist"
}
