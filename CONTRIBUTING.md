# Contributing

## Quick start

```bash
./build.sh check     # everything verifiable locally (must pass before a PR)
./build.sh web       # browser PWA build
./build.sh services social   # one service crate (heavy first build)
```

Read `AGENTS.md` first — it has the repo map, the exact commands, and the
gotchas (SDK quirks, frozen identifiers, test conventions).

## Ground rules

- **One change, one place, one test.** New pure logic goes in a workspace
  crate or a dependency-free `web/src/**/*.ts|.mjs`, with a test in the same
  change (`cargo test` / `node --test web/test`). Enforcement controls are
  named after their `docs/05-security.md` section.
- **Reference crypto stays reference.** `crates/sphinx-core` is educational;
  production paths must use Nym's audited packages.
- **No secrets in the tree.** Runtime keys, sqlite files, and printed
  addresses are gitignored (`services/*/sp-storage/`, `*.sqlite*`,
  `nym-address.txt`). Never commit them, even redacted "examples".
- **Docs travel with code.** Changed behavior? Update the matching
  `docs/*.md` and keep every relative link valid (`./build.sh check`
  enforces this).
- **Keep it offline-friendly.** `check` runs without network; mark or skip
  tests that need one (see the noble dynamic-import pattern in
  `web/test/dm-crypto.test.mjs`).

## PRs

Small, focused, with: what changed, why, how you verified (`check` output).
CI runs `check` on every push/PR; `web-build` and `android` are advisory.

## License

Apache-2.0. Contributions land under the same license (`LICENSE`).
