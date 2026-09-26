# Security policy

## Supported versions

Pre-1.0 software: the latest `main` and the latest tagged release are
supported. Older tags are not.

## Reporting a vulnerability

**Do not open a public issue.** Use one of these private channels:

1. GitHub: **Security → Report a vulnerability** on the repository page
   (private advisories; preferred).
2. If that is unavailable, open a minimal issue titled "security contact
   request" with no details — we will open a private channel.

Please include: what you found, where (file/commit/tag), what an attacker
gains, and steps to reproduce if you have them. We aim to acknowledge within
72 hours and to ship a fix before any public disclosure. Coordinated
disclosure is appreciated: please give us a chance to patch before going
public.

## Scope notes for researchers

- The interesting attack surface is: the mixnet message handling in
  `web/src/mixnet/` and `services/*/src/`, the envelope/signature code in
  `crates/nym-hidden-service` and `web/src/domain/identity.ts`, and the open-proxy
  guards in `crates/bridge-guard`.
- `crates/sphinx-core` is a reference implementation, not production code —
  bugs there are documentation bugs unless they also affect the claims in
  `docs/`.
- Social engineering, physical access, and the Nym network itself are out of
  scope. See `docs/05-security.md` for the threat model (L1/L2/L3L/L3G actors)
  before reporting anything "missing" that is a documented non-goal.
