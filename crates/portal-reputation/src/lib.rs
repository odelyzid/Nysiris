//! Spam/Sybil resistance primitives.
//!
//! Three independent pieces, each pure and testable:
//!
//! * [`pow`]: client-side proof-of-work. Proves cost, not identity: anyone
//!   can post, but mass posting costs CPU. Providers verify in microseconds.
//! * [`reputation`]: local scores from first-hand observation. Never fetched
//!   from a server — a remote score is just another claim.
//! * [`rate`]: provider-side per-author budgets. The backstop when PoW pricing
//!   is wrong or an attacker pays it.
//!
//! See `docs/10-portal.md` §10.5 for how they compose.

pub mod pow;
pub mod rate;
pub mod reputation;
