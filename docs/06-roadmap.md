# 6. Implementation Roadmap

A step-by-step plan from this foundation to a working browser client and hosted
service. Each phase has explicit **acceptance criteria** so progress is
verifiable rather than vibes-based.

> **Progress note.** Phase 0 is done. Phase 1 (browser client) and Phase 3
> (hosting) now have working scaffolds — see `web/`, `services/`, and
> `docs/03-browser-client.md` / `docs/04-hosting-services.md`. The acceptance
> criteria below still require a machine with the Nym toolchain to demonstrate.

---

## Phase 0 — Foundations ✅ (this change)

**Deliverables**
- `docs/01-architecture.md` — system view, modes, trust boundaries.
- `docs/02-addressing-and-routing.md` — no-DNS model, byte layouts, algorithm.
- `crates/sphinx-core/` — reference Sphinx: header, blinding, filler, MAC,
  Lioness payload, SURB, address parsing, path selection.
- This roadmap.

**Acceptance criteria**
- [x] `cargo test -p sphinx-core` passes: 3-hop build→process→recover, tamper
      rejection, SURB reply, address round-trip.
- [x] Packet geometry equals production: header 348, payload 2065, total 2413.
- [x] Key schedule matches `sphinx-packet` (X25519 + HKDF-SHA256 → 288 B).

> **Gate before Phase 1.** Read §1.1's production rule. From here on, the
> browser and service code depends on Nym's audited crates. `sphinx-core`
> stays as documentation/test vectors.

---

## Phase 1 — Browser client (mix-tunnel wrapper + React UI) — scaffolded

**Deliverables** (see `web/` and [`03-browser-client.md`](03-browser-client.md))
- `web/` React app: connection status, chosen path + hop count, pure-mixnet vs
  exit, latency, leak-guard state.
- `workers/mixnet.ts`: memoised one-shot `ensureTunnel()` around
  `setupMixTunnel`, lazy dynamic import, hard/soft disconnect.
- Request modes:
  - `mixFetch(url, init)` — clearnet HTTPS via IPR exit.
  - direct Nym-address messaging via `@nymproject/sdk` (`send` /
    `wait_for_messages`, `send_reply`).
  - `MixWebSocket` for streaming clearnet services.
- **Leak guard**: wrap `fetch`/`XHR.open`; configurable fail-open/closed.
- CSP template: `worker-src 'self' blob:`, `connect-src 'self' wss:
  https://validator.nymtech.net ...`.

**Acceptance criteria**
- [ ] `mixFetch('https://echo.example/ip')` returns a source IP different from
      clearnet `fetch` (the "prove the tunnel carried it" test).
- [ ] Direct request to a routed host is blocked in fail-closed mode.
- [ ] Second `ensureTunnel()` call does not spawn a second tunnel.
- [ ] UI shows hop count and exit-vs-pure correctly.
- [ ] Bundle builds; WASM worker loads under the CSP template.

**Notes / gotchas**
- One tunnel per page; reload required after disconnect.
- Expect a multi-MB worker chunk; never block first paint on it.

---

## Phase 2 — Browser extension (MV3)

**Deliverables**
- `extension/` manifest v3, background service worker hosting the tunnel.
- Tabs routed through the mixnet for allow-listed hosts (declarativeNetRequest
  can only redirect; actual routing happens in the worker — document this).
- Popup: on/off, per-site rule, current path, exit selection.
- Firefox build via `web-ext`.

**Acceptance criteria**
- [ ] Extension loads unpacked in Chrome and Firefox.
- [ ] Allow-listed host requests go through the mixnet; all others remain direct.
- [ ] No direct leak for an allow-listed host with fail-closed on.

**Honest constraint.** A browser extension still cannot transparently proxy
*all* browser traffic (no system-wide SOCKS). For true "browser traffic through
the mixnet", the supported paths are (a) route requests inside your own page
with `mixFetch`, or (b) ship a companion local `nym-socks5-client` and set the
OS/browser proxy to `127.0.0.1:1080`. State this in the README.

---

## Phase 3 — Service hosting — scaffolded

See `services/` and [`04-hosting-services.md`](04-hosting-services.md).

### 3A. Pure mixnet service provider (recommended)
- `services/echo-provider/` — Rust, `nym-sdk` `MixnetClient` with
  `StoragePaths` (stable identity) and `wait_for_messages` / `send_reply`.
- Pin to a chosen Gateway with `request_gateway(...)`.
- Reply budget accounting (default ≈50 real packets/s shared across all
  clients; idle cover ≈5/s).

**Acceptance:** provider prints a stable Nym address across restarts; a client
sends a message and receives a SURB reply.

### 3B. Hybrid / clearnet-facing
- `services/hybrid/` — `docker-compose.yml` with `caddy` (or nginx) + a Nym
  exit/requester front end. Document which parts are exposed and which are not.

**Acceptance:** clearnet clients reach the service normally; mixnet clients
reach it by Nym address; no inbound port is required for the pure path.

### 3C. Self-hosted Nym Gateway
- `services/gateway/` — `nym-node` config, static public IP requirement, systemd
  unit, and registration via `nyxd`/`nym-cli`.
- Document the DMZ split: Gateway public, provider private.

**Acceptance:** provider address is stable because it depends on a Gateway you
control; `nym-cli` shows the node registered and bonded.

---

## Phase 4 — Security hardening & operations — controls enforced & tested

The threat model is in
[`05-security.md`](05-security.md); the controls are implemented and tested:

- `crates/sphinx-core/src/enforcement.rs` — route policy (no repeated operator,
  no entry/exit collusion), SURB single-use + expiry, bounded SURB attachment,
  reply budget, exit rotation, cover-traffic guardrail.
- `web/src/mixnet/enforcement.mjs` — the same controls at browser runtime:
  reply dedupe + TTL, reply rate limiting, the cover-traffic guardrail wired
  into `ensureTunnel`, and exit-rotation guidance in `mixnetFetch`.
- `crates/bridge-guard/` — open-proxy guards for the hybrid bridge.
- `web/src/mixnet/routedHosts.mjs` + `web/test/routedHosts.test.mjs` — leak-guard
  decisions, verified with `node --test`.
- `crates/sphinx-core/tests/fuzz_parser.rs` — deterministic mutation fuzzing of
  the packet/header/payload/address parsers (runs in `check`).
- `crates/sphinx-core/tests/soak.rs` + `crates/sphinx-core/fuzz/` — heavy route
  soak (release) and optional coverage-guided fuzzing.
- `.github/workflows/ci.yml` runs `./build.sh check` on every push/PR.

**Verification commands**

```bash
./build.sh check       # 32 Rust tests + 16 web tests, clippy -D warnings, docs
./build.sh soak        # SPHINX_SOAK_ITERS=5000 route/message soak (release)
./build.sh acceptance  # live-network delivery + SURB reply (needs the Nym toolchain)
cd crates/sphinx-core && cargo +nightly fuzz run parse_packet   # optional
```

**Verified on mainnet** (2026-09-19, Rust 1.94, `nym-sdk` 1.21.6): the harness
built in ~4.5 minutes and passed — delivery RTT ≈ 7.6 s, SURB reply RTT ≈ 7.1 s.
Reproduce with `./build.sh acceptance`; setup is in
`services/acceptance/README.md`.

**Remaining follow-ups**: keep the live test in a scheduled (not per-PR) job,
extend the fuzz corpus over time, and add a browser end-to-end test once a
headless WASM harness is available.

---

## Phase 6 — Desktop (Linux Mint / Debian) — implemented

A native `.deb` that serves the PWA on loopback and opens it in a Chromium
`--app` window. See [`07-desktop-linux.md`](07-desktop-linux.md).

- `desktop/launcher/` — dependency-free Rust launcher; unit-tested (path
  traversal, MIME, cross-origin-isolation headers). Runs in `./build.sh check`.
- `desktop/debian/` — `control`, `postinst`, `prerm`, `.desktop`, icon and a
  `build-deb.sh` producing `dist/fly-protocol_<version>_<arch>.deb`.
- `desktop/electron/` — Electron alternative (bundled Chromium) for users
  without a system Chromium.

```bash
./build.sh web
./build.sh desktop          # -> dist/fly-protocol_0.1.0_amd64.deb
sudo apt install ./dist/fly-protocol_0.1.0_amd64.deb
```

**Verified**: `.deb` builds and its layout is correct; the launcher returns
`200` with `COOP`/`COEP`/`CORP`, serves `application/wasm`, rejects raw and
percent-encoded path traversal with `400`, and applies the SPA fallback.

**Remaining follow-ups**: a Tauri/WebKitGTK spike with the §7.5 checklist, a
Flatpak manifest, and an apt repository with GPG signing for distribution.

- Threat model review against §5 (tagging, timing, SURB hoarding, exit trust,
  replay, n-1 attacks).
- Cover traffic tuning: Poisson rates, loop cover, `disable_*` flags and their
  privacy cost.
- Observability without leaking: metrics that never log destinations/addresses.
- Key management: storage encryption at rest, key rotation, SURB pool purge
  (24-epoch validity).
- Fuzz/soak: malformed headers/payloads, replay filter behaviour.

**Acceptance:** written threat-model sign-off; no plaintext destination or Nym
address in logs; soak test survives 10⁶ packets without leaks or panics.

---

## Phase 5 — Optional clearnet exit / outproxy

Only if you need to *operate* an exit (as opposed to using existing ones):
- `nym-node --mode exit-gateway` with the Network Requester and IPR.
- Explicit **exit policy** (ports/hosts) and abuse handling.
- Legal review: running an exit changes your risk profile materially.

**Acceptance:** policy denies by default; documented logging/abuse process.

---

## Cross-cutting decisions to record

| Decision | Recommendation | Rationale |
|---|---|---|
| Reimplement Sphinx? | **No.** Use `mix-tunnel` / `nym-sdk`. | Audited crypto; `sphinx-core` is reference only. |
| Local daemon vs WASM? | WASM in-browser; local `nym-socks5-client` for non-web apps | Browsers cannot open raw sockets |
| Naming | Ship addresses in config; no public directory | Avoid enumerability/unlinkability loss |
| Path length | 5 Sphinx hops (entry, 3 mixes, destination gw) | Matches `MAX_PATH_LENGTH = 5` |
| Exit vs pure | Pure by default; exit only when the destination is clearnet | Strongest privacy for services you control |
| Reply strategy | SURBs (single-use) + replenishment for large replies | No address disclosure |
| Transport | WSS to Entry Gateway | Browser-compatible, TLS-protected |

---

## Definition of done (overall)

1. A user can open the web app/extension, see the mixnet status and path, and
   fetch a clearnet URL through an Exit Gateway with a different source IP.
2. The same client can exchange messages with a pure mixnet service by Nym
   address, using SURBs for replies.
3. A service can be hosted with no inbound ports, with a stable Nym address, and
   with clear operational docs.
4. Security analysis and a threat model are written down and reviewed.
