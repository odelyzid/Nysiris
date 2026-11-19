//! Seller reputation from **raw, signed reviews** — never a server score.
//!
//! The provider stores one signed review per fulfilled order and serves them
//! back verbatim. There is deliberately no published aggregate: a remote
//! score is just another claim (docs/10-portal.md §10.5, docs/05-security.md).
//! Clients re-verify each review signature against the buyer key and compute
//! this summary locally, so a provider cannot inflate or bury a rating.
//!
//! This module is the pure arithmetic both sides share, plus the rating
//! bounds. It is not a trust signal on its own: a fresh seller with five
//! reviews and a long-lived seller with five hundred are different things.

/// Minimum star rating.
pub const MIN_RATING: u8 = 1;
/// Maximum star rating.
pub const MAX_RATING: u8 = 5;

/// Local aggregate over one seller's verified reviews.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReviewSummary {
    /// Number of reviews counted.
    pub count: usize,
    /// Sum of the star ratings (used for an exact mean).
    pub sum: u64,
}

impl ReviewSummary {
    /// Mean rating scaled by 100, rounded down. `0` when there are no
    /// reviews, so callers can render "no ratings yet" explicitly.
    pub fn average_x100(&self) -> u64 {
        if self.count == 0 {
            0
        } else {
            self.sum.saturating_mul(100) / self.count as u64
        }
    }

    /// The mean as a float for display only. Never signs or compares floats.
    pub fn average(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            self.sum as f64 / self.count as f64
        }
    }
}

pub fn rating_is_valid(rating: u8) -> bool {
    (MIN_RATING..=MAX_RATING).contains(&rating)
}

/// Summarize ratings that already passed signature verification and bounds.
/// Invalid ratings are ignored rather than allowed to poison the average.
pub fn summarize(ratings: impl IntoIterator<Item = u8>) -> ReviewSummary {
    let mut summary = ReviewSummary { count: 0, sum: 0 };
    for rating in ratings {
        if rating_is_valid(rating) {
            summary.count += 1;
            summary.sum += rating as u64;
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_counts_only_valid_ratings() {
        let s = summarize([5, 4, 0, 6, 3]);
        assert_eq!(s.count, 3);
        assert_eq!(s.sum, 12);
        assert_eq!(s.average_x100(), 400);
    }

    #[test]
    fn empty_summary_is_zero_not_a_division_error() {
        let s = summarize([]);
        assert_eq!((s.count, s.sum, s.average_x100()), (0, 0, 0));
        assert_eq!(s.average(), 0.0);
    }

    #[test]
    fn rating_bounds_are_inclusive() {
        assert!(rating_is_valid(1));
        assert!(rating_is_valid(5));
        assert!(!rating_is_valid(0));
        assert!(!rating_is_valid(6));
    }
}
