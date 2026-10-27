# Version bumping. Single source of truth is ./VERSION.
# shellcheck shell=bash
#
# `./build.sh bump <part|X.Y.Z>` rewrites VERSION and the JS manifests, then
# commits those files and creates the annotated `v<version>` tag. Tagging the
# commit *before* the bump is the classic release failure
# ("tag vX does not match VERSION"), so the default flow keeps them together.
#
# Escape hatches:
#   BUMP_NO_COMMIT=1  write the files but leave them uncommitted (no tag)
#   BUMP_NO_TAG=1     commit the bump but do not create the tag
#   BUMP_RETAG=1      move an existing v<version> tag to the new bump commit
cmd_bump() {
  local part="${BUMP_PART:-patch}"
  local current next
  current="$(cat "$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"

  if [[ "$part" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    next="$part"
  else
    local major minor patch
    IFS=. read -r major minor patch <<<"$current"
    case "$part" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) die "usage: ./build.sh bump [major|minor|patch|X.Y.Z]" ;;
    esac
    next="$major.$minor.$patch"
  fi

  # Files that must carry the version. Only the ones that exist are committed.
  local version_files=(
    VERSION
    web/package.json
    web/package-lock.json
    desktop/electron/package.json
    desktop/electron/package-lock.json
  )

  local in_git=0 git_branch="" retag=0
  if have git && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    in_git=1
    git_branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
    [[ "${BUMP_RETAG:-0}" == "1" ]] && retag=1
  fi

  # Refuse to silently reuse a tag that points somewhere else: that is exactly
  # how a release ends up building a tree whose VERSION disagrees with the tag.
  if ((in_git)) && ((!retag)) && git -C "$ROOT" rev-parse -q --verify "refs/tags/v$next" >/dev/null; then
    die "tag v$next already exists at $(git -C "$ROOT" rev-parse --short "v$next^{commit}"); bump a new version or rerun with BUMP_RETAG=1 to move it"
  fi

  if [[ "$current" == "$next" ]]; then
    warn "version is already $next"
    if ((in_git)) && [[ "${BUMP_NO_TAG:-0}" != "1" ]] && ! git -C "$ROOT" rev-parse -q --verify "refs/tags/v$next" >/dev/null; then
      echo
      echo "Version matches but v$next is not tagged. To tag the current commit:"
      echo "  git tag -a v$next -m \"v$next\" && git push origin $git_branch v$next"
    fi
    return 0
  fi

  if ((in_git)) && [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]]; then
    warn "working tree has uncommitted changes; only the version files will be committed"
  fi

  log "bumping $current -> $next"
  printf '%s\n' "$next" > "$ROOT/VERSION"

  # Keep the JS manifests in step (no install needed for `npm pkg set`).
  # `npm pkg set` does not touch package-lock.json, so sync the lockfile
  # version fields too; otherwise `npm ci` / fresh checkouts drift and the
  # web build fails on stale node_modules (TS2688 vite/client).
  if have node; then
    (cd "$ROOT/web" && npm pkg set version="$next" >/dev/null)
    (cd "$ROOT/desktop/electron" && npm pkg set version="$next" >/dev/null)
    node -e '
      const fs = require("node:fs");
      const root = process.env.ROOT || process.cwd();
      for (const rel of ["web/package-lock.json", "desktop/electron/package-lock.json"]) {
        const p = root + "/" + rel;
        try {
          const lock = JSON.parse(fs.readFileSync(p, "utf8"));
          lock.version = process.argv[1];
          if (lock.packages && lock.packages[""]) lock.packages[""].version = process.argv[1];
          fs.writeFileSync(p, JSON.stringify(lock, null, 2) + "\n");
          console.log("synced " + rel);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
    ' "$next"
    ok "updated VERSION, web/package.json, desktop/electron/package.json (+ lockfiles)"
  else
    warn "node not found; only ./VERSION was updated"
  fi

  local committed=0
  if ((in_git)) && [[ "${BUMP_NO_COMMIT:-0}" != "1" ]]; then
    local paths=() f
    for f in "${version_files[@]}"; do
      [[ -e "$ROOT/$f" ]] && paths+=("$f")
    done
    git -C "$ROOT" add -- "${paths[@]}"
    if git -C "$ROOT" diff --cached --quiet -- "${paths[@]}"; then
      warn "no version changes to commit (already at $next?)"
    else
      git -C "$ROOT" commit -m "release: $next" -- "${paths[@]}" >/dev/null
      committed=1
      ok "committed release: $next"
    fi
  fi

  if ((in_git)) && ((committed)) && [[ "${BUMP_NO_TAG:-0}" != "1" ]]; then
    if ((retag)); then
      git -C "$ROOT" tag -f -a "v$next" -m "v$next"
      ok "moved tag v$next to $(git -C "$ROOT" rev-parse --short HEAD)"
    else
      git -C "$ROOT" tag -a "v$next" -m "v$next"
      ok "tagged v$next at $(git -C "$ROOT" rev-parse --short HEAD)"
    fi
  fi

  echo
  echo "Next:"
  if ((in_git)) && ((committed)); then
    echo "  git push origin $git_branch"
    if [[ "${BUMP_NO_TAG:-0}" != "1" ]]; then
      if ((retag)); then
        echo "  git push --force origin v$next    # tag was moved"
      else
        echo "  git push origin v$next"
      fi
    else
      echo "  git tag -a v$next -m \"v$next\" && git push origin $git_branch v$next"
    fi
  elif ((in_git)); then
    echo "  git add VERSION web/package.json web/package-lock.json desktop/electron/package.json desktop/electron/package-lock.json"
    echo "  git commit -m \"release: $next\""
    echo "  git tag -a v$next -m \"v$next\" && git push origin $git_branch v$next"
  else
    echo "  commit the version files and tag v$next in your VCS before publishing"
  fi
  echo
  echo "  ./build.sh desktop                      # system-Chromium .deb ($next)"
  echo "  ./build.sh desktop --electron           # Electron .deb + AppImage"
  echo "  ./build.sh web && ./build.sh android    # PWA / Android"
  echo "  ./build.sh check                        # verify"
}

# Allow running the script directly (`scripts/cmd-bump.sh patch`) without
# silently doing nothing, which is an easy way to tag a stale commit.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export ROOT
  # shellcheck source=scripts/lib.sh
  source "$ROOT/scripts/lib.sh"
  BUMP_PART="${1:-patch}"
  cmd_bump
fi
