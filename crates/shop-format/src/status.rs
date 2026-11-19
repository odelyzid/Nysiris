//! Order state machine (pure, shared by provider and client).
//!
//! States are wire codes; the JSON API spells them out. Transitions are
//! role-scoped: a buyer may cancel, a seller may accept/decline/fulfil. No
//! transition is ever inferred from a timer — an order stays where the two
//! parties left it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    /// Buyer signed the order and the provider reserved stock.
    Reserved = 0,
    /// Seller accepted the reservation.
    Accepted = 1,
    /// Seller marked it fulfilled (the only state a review may follow).
    Fulfilled = 2,
    /// Seller declined; reserved stock was released.
    Declined = 3,
    /// Buyer cancelled; reserved stock was released.
    Cancelled = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActorRole {
    Buyer,
    Seller,
}

impl OrderStatus {
    pub fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::Reserved),
            1 => Some(Self::Accepted),
            2 => Some(Self::Fulfilled),
            3 => Some(Self::Declined),
            4 => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Accepted => "accepted",
            Self::Fulfilled => "fulfilled",
            Self::Declined => "declined",
            Self::Cancelled => "cancelled",
        }
    }

    /// Whether `role` may move an order from `self` to `next`.
    pub fn can_transition(self, role: ActorRole, next: Self) -> bool {
        match (role, self, next) {
            // Seller: accept or decline a fresh reservation.
            (ActorRole::Seller, Self::Reserved, Self::Accepted) => true,
            (ActorRole::Seller, Self::Reserved, Self::Declined) => true,
            // Seller: fulfil an accepted order.
            (ActorRole::Seller, Self::Accepted, Self::Fulfilled) => true,
            // Buyer: cancel anything not yet fulfilled/closed.
            (ActorRole::Buyer, Self::Reserved, Self::Cancelled) => true,
            (ActorRole::Buyer, Self::Accepted, Self::Cancelled) => true,
            _ => false,
        }
    }

    /// Statuses that release the reserved quantity back to the listing.
    pub fn releases_stock(self) -> bool {
        matches!(self, Self::Declined | Self::Cancelled)
    }

    /// Only a fulfilled order may be reviewed.
    pub fn is_reviewable(self) -> bool {
        self == Self::Fulfilled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_and_unknown_codes_fail() {
        for code in 0..=4 {
            assert_eq!(OrderStatus::from_code(code).unwrap().code(), code);
        }
        assert!(OrderStatus::from_code(5).is_none());
    }

    #[test]
    fn transitions_are_role_scoped() {
        use ActorRole::{Buyer, Seller};
        use OrderStatus::*;
        assert!(Reserved.can_transition(Seller, Accepted));
        assert!(Reserved.can_transition(Seller, Declined));
        assert!(Accepted.can_transition(Seller, Fulfilled));
        assert!(Reserved.can_transition(Buyer, Cancelled));
        assert!(Accepted.can_transition(Buyer, Cancelled));

        // No buyer acceptance/fulfilment, no seller cancellation, no revival.
        assert!(!Reserved.can_transition(Buyer, Accepted));
        assert!(!Reserved.can_transition(Buyer, Fulfilled));
        assert!(!Accepted.can_transition(Buyer, Fulfilled));
        assert!(!Reserved.can_transition(Seller, Cancelled));
        assert!(!Fulfilled.can_transition(Buyer, Cancelled));
        assert!(!Fulfilled.can_transition(Seller, Declined));
        assert!(!Cancelled.can_transition(Seller, Accepted));
    }

    #[test]
    fn only_unfulfilled_orders_release_stock() {
        assert!(OrderStatus::Declined.releases_stock());
        assert!(OrderStatus::Cancelled.releases_stock());
        assert!(!OrderStatus::Reserved.releases_stock());
        assert!(!OrderStatus::Accepted.releases_stock());
        assert!(!OrderStatus::Fulfilled.releases_stock());
    }
}
