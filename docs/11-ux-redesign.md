# 11. UX Redesign — Calm, Private-by-Default Client

> Status: implemented in `web/src/`. Security architecture unchanged:
> browser = application, service = data. `crates/sphinx-core` remains a
> reference implementation, never production crypto.

## 1. Information architecture

Top-level navigation (always visible, mobile-friendly):

| View | Everyday name | What it holds |
|---|---|---|
| Home | Home | Onboarding card, protection status, "Open a private link" bar (the existing `nym://` URI bar, unchanged behaviour), recent people/places shortcuts |
| Messages | Messages | Chat list + conversation view over the existing `NymAddressClient` inbox. No raw addresses in the list — petnames / short labels only |
| Portal | Portal | Private-site viewer (`iframe`, URI-bar binding preserved) + community with Timeline / Private messages / About tabs. Identity keys stay in `localStorage` as before |
| Settings | Settings | Everyday settings (private network on/off, my private link + copy/QR, people, notifications). Technical tools collapsed under **Advanced** (hidden by default) |

**Advanced (hidden by default)** keeps the exact previous panels, untouched
behaviour: pure mixnet messaging details, manual private-site fetch, topology /
exit details, raw logs, key import/export, cover-traffic toggles. Nothing was
removed — it moved one tap away. The old `PanelId` registry (`web/src/ui/panels.ts`)
is preserved so existing tests and persisted state keep working.

View switching is toolbar-controlled; background work (tunnel, inbox, feed
polling) keeps running when a view is hidden, same guarantee the old panels had.

## 2. Key screens

### Home / first run

```
Welcome → [Connect privately] → automatic best setup → success state
```

- First run shows a 3-step onboarding card, no gateway/topology jargon.
- Returning users see a compact status card + one-tap connect.
- Gateway/topology details only appear under Settings → Advanced → Technical details.

### Messages

Familiar chat pattern: left (or top on mobile) conversation list, right (or
below) conversation thread + composer. Long addresses are shortened to
`ABC123…XYZ9` with the full value behind "Show technical details". Reply-via-SURB
is just "Reply" — the SURB detail lives in Advanced.

### Portal

One "Open a private link" bar (same `parseInviteLink` → `fetchNym` → bind
`socialService` path as before, so URI-bar binding behaviour is preserved).
Successful navigation renders the private site and binds the community to it.
Invite links show a friendly "Someone invited you" card with petname save.

The community (`web/src/social/`) has three persisted tabs
(`web/src/social/tabs.ts`, `fly.social.tab`):

- **Timeline** — composer + global chronological timeline
  (`GET /feed?since=<seq>&limit=<n>`, `POST /post`, max 1400 bytes).
  Opening a portal auto-pulls recent posts you don't have yet
  (`web/src/social/sync.ts`: dedupe by `seq`, cap 200), even before an
  identity exists — reading needs no key. A sync-status line always shows
  freshness ("Up to date — checked just now" / "Syncing…" / error + Retry),
  and the empty state is a friendly "Nothing here yet" card with a
  "Be the first to post" call to action. Top-level posts show a reply-count
  pill; opening one switches to the dedicated thread view
  (`web/src/social/ThreadView.tsx`: root on top, transitive replies
  chronological, missing ancestors auto-pulled via `GET /post/<id>`).
  Replying attaches `in_reply_to` with a parent preview chip in the composer.
  Threading model: `docs/09-social.md` §9.5a — the service stores + verifies
  the parent link only; all assembly is client-side.
- **Private messages** — sealed DM composer + received messages
  (`POST /dm`, `GET /dm?for=<pubkey>`, self-destruct on read). A
  self-destruct callout sells the privacy property; received messages carry
  local timestamps (the envelope has none, by design) and a "Check for new
  messages" button supplements the 30s poll.
- **About** — profile editor (`GET /profile/<pubkey>`, `POST /profile`),
  the service description, and the technical log (logs hidden by default).

Trust is two local layers, both in `web/src/social/trust.ts` (colours in one
`STANDING_META` map, shown with a visible legend): first-hand observations
from signature checks, plus your explicit per-author Trust/Block verdict,
which always wins. Petnames (`web/src/social/petnames.ts`, "Name" button per
post) beat profile names beat short hex for display. Everything — scores,
verdicts, petnames — stays in `localStorage` and never leaves the device.

Identity is one tap ("Create my private ID"), shareable via copy + local QR,
and movable with a guided two-step export/import flow (explicit secret reveal
with copy, then paste on the other device).

The tabs mirror the provider's landing page (`DESCRIPTOR_HTML` in
`services/social/src/service.rs`), which serves the same copy with matching
Timeline / Private messages sections: "Metadata-minimal microblog +
encrypted DMs, reachable only over the Nym mixnet. … No accounts, no follows,
no likes, no read receipts. Your public key is your name."

### Settings

- Private network: on/off, "Prove I'm protected" (the old IP-comparison proof,
  renamed).
- My private link: short label + Copy link + Show QR + Show technical details.
- People: petname address book (was Contacts), Visit / Remove.
- Advanced (collapsed): technical panels, raw logs, exit-rotation note,
  key import, privacy-downgrade toggles.

## 3. Status & errors

Persistent, discreet pill in the nav:

| Tunnel state | Pill |
|---|---|
| `ready` | ● Protected (green) |
| `connecting` | ● Connecting… (amber) |
| `shutdown` | ○ Not protected (grey) |
| `shutting_down` | ● Switching off… (amber) |
| `failed` | ● Something went wrong (red) |

Clicking the pill opens a popover with one friendly sentence, what to do next
("Try again"), and a collapsed "Technical details" + "Copy error" for reports.
Raw SDK errors never reach the main view; `friendlyError()` in
`web/src/ui/friendlyErrors.ts` maps them.

## 4. Language map (main UI → advanced)

| Main UI (everyday) | Advanced / technical (exact) |
|---|---|
| Private network | Nym mixnet / mix-tunnel |
| Private address / Private link | `nym://identity.encryption@gateway` |
| Private site / Portal | Hidden service / `fetchNym` |
| People | Contacts / petname registry |
| Not protected / Protected | Tunnel `shutdown` / `ready` |
| Something went wrong | Tunnel `failed: <reason>` |

Long cryptographic addresses only appear behind "Show technical details" or in
Advanced. Petnames are the primary label everywhere.

## 5. Sharing (petname / copy-link / QR)

`ShareCard` (`web/src/ui/ShareCard.tsx`) shows:

1. Short label (`shop • ABC123…XYZ9`) — petname first.
2. **Copy link** button (clipboard + fallback select).
3. **Show QR** button — renders a scannable QR of the full `nym://` link via
   the `qrcode` package to a `<canvas>`/data-URL `<img>`. No network involved;
   generation is fully local so the private link never leaves the device.
4. **Show technical details** toggle revealing the full address + invite fragment.

## 6. Visual design

- Calm light theme (`web/src/ui/theme.css`): system-ui, generous spacing,
  44px+ touch targets, AA contrast, single-column ≤ 860px, two-column chat on
  wider screens. Respects `prefers-color-scheme` and `prefers-reduced-motion`.
- No new network or crypto code: all views reuse `ensureTunnel`,
  `NymAddressClient`, `fetchNym`, `parseInviteLink`, `Social`, contacts storage.
- PWA / desktop launcher / Android paths unchanged; layout is responsive and
  touch-safe for TWA/Capacitor.

## 7. Flows (text screenshots)

**First run:** Home shows "Welcome to Nysiris — browse and chat privately."
→ [Connect privately] → "Connecting… finding the fastest private path."
→ "You're protected ✓" + [Open a private link] field.

**Something went wrong:** nav pill turns red, "Something went wrong".
Tap → "We couldn't reach the private network. Check your connection and try
again." [Try again] [Copy error] → details: `tunnel failed: …`.

**Invite:** paste link → Portal shows "You've been invited by Maya —
'Join me here'" → [Save as…] → appears in Messages/People as "Maya".

## 8. Verification

```bash
./build.sh check   # fmt + clippy + Rust tests + web unit tests + docs
./build.sh web     # PWA build (tsc + vite)
```

New pure-logic tests: `web/test/views.test.mjs`, `web/test/friendlyErrors.test.mjs`,
`web/test/share.test.mjs`. Existing `panels`/`contacts` tests untouched.
