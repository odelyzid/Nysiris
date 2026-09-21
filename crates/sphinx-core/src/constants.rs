//! Wire-format constants for the Nym Sphinx packet.
//!
//! Every value here is mirrored from Nym's `sphinx-packet` crate
//! (`common/nymsphinx/...` and the `sphinx-packet` facade) so the reference
//! implementation has the *same geometry* as the production network. See
//! `docs/02-addressing-and-routing.md` for the derivation of each value.
//!
//! The numbers below produce a **regular packet of exactly 2413 bytes**:
//!
//! ```text
//! 2413 = HEADER_SIZE (348) + PAYLOAD_SIZE (2048) + PAYLOAD_OVERHEAD_SIZE (17)
//! ```

/// `k` in the Sphinx paper. 128 bits, measured in bytes.
pub const SECURITY_PARAMETER: usize = 16;

/// `r` in the Sphinx paper: maximum number of hops the header can address.
/// Nym uses a 3-layer mixnet in production, leaving headroom for an entry and
/// exit hop inside the same header.
pub const MAX_PATH_LENGTH: usize = 5;

/// A node address is a truncated hash of the node's identity key.
pub const NODE_ADDRESS_LENGTH: usize = 2 * SECURITY_PARAMETER; // 32

/// The final recipient's Sphinx identity (its client encryption public key).
pub const DESTINATION_ADDRESS_LENGTH: usize = 2 * SECURITY_PARAMETER; // 32

/// SURB identifier / client-assigned message id.
pub const IDENTIFIER_LENGTH: usize = SECURITY_PARAMETER; // 16

/// One byte routing flag: 1 = forward hop, 2 = final hop.
pub const FLAG_LENGTH: usize = 1;
pub const FORWARD_HOP: u8 = 1;
pub const FINAL_HOP: u8 = 2;

/// Version is encoded as `major.minor.patch` inside every routing block so
/// nodes can evolve the format without a hard fork.
pub const VERSION_LENGTH: usize = 3;

/// Per-hop randomised delay, nanoseconds, big-endian.
pub const DELAY_LENGTH: usize = 8;

/// 32 + 1 + 8 + 3 = 44. The routing block a *forwarding* node reads.
pub const NODE_META_INFO_SIZE: usize =
    NODE_ADDRESS_LENGTH + FLAG_LENGTH + DELAY_LENGTH + VERSION_LENGTH; // 44

/// 32 + 16 + 1 + 3 = 52. The routing block the *final* recipient reads.
pub const FINAL_NODE_META_INFO_LENGTH: usize =
    DESTINATION_ADDRESS_LENGTH + IDENTIFIER_LENGTH + FLAG_LENGTH + VERSION_LENGTH; // 52

/// Truncated HMAC over the encrypted routing information (gamma in the paper).
pub const HEADER_INTEGRITY_MAC_SIZE: usize = SECURITY_PARAMETER; // 16

/// mac key length inside the expanded shared secret.
pub const INTEGRITY_MAC_KEY_SIZE: usize = SECURITY_PARAMETER; // 16

/// AES-128-CTR key used to generate the header keystream.
pub const STREAM_CIPHER_KEY_SIZE: usize = 16;
pub const STREAM_CIPHER_INIT_VECTOR: [u8; 16] = [0u8; 16];

/// Size of the encrypted routing information (beta) carried in the header.
/// `(NODE_META_INFO_SIZE + HEADER_INTEGRITY_MAC_SIZE) * MAX_PATH_LENGTH`
pub const ENCRYPTED_ROUTING_INFO_SIZE: usize =
    (NODE_META_INFO_SIZE + HEADER_INTEGRITY_MAC_SIZE) * MAX_PATH_LENGTH; // 300

/// How much of the *next* layer's encrypted routing info is embedded in the
/// current layer before the filler fills the rest back in.
pub const TRUNCATED_ROUTING_INFO_SIZE: usize =
    ENCRYPTED_ROUTING_INFO_SIZE - (NODE_META_INFO_SIZE + HEADER_INTEGRITY_MAC_SIZE); // 240

/// Bytes of PRNG output a single hop is allowed to consume.
pub const STREAM_CIPHER_OUTPUT_LENGTH: usize =
    (NODE_META_INFO_SIZE + HEADER_INTEGRITY_MAC_SIZE) * (MAX_PATH_LENGTH + 1); // 360

/// One filler "step" == one (meta || mac) block.
pub const FILLER_STEP_SIZE_INCREASE: usize = NODE_META_INFO_SIZE + HEADER_INTEGRITY_MAC_SIZE; // 60

/// alpha (first 32 B) || gamma (16 B) || beta (300 B).
pub const HEADER_SIZE: usize = 32 + HEADER_INTEGRITY_MAC_SIZE + ENCRYPTED_ROUTING_INFO_SIZE; // 348

/// Leading zero padding (16 B) + the `0x01` padding delimiter (1 B).
pub const PAYLOAD_OVERHEAD_SIZE: usize = SECURITY_PARAMETER + 1; // 17

/// Maximum user-visible plaintext inside one regular packet.
pub const DEFAULT_PLAINTEXT_SIZE: usize = 2048;

/// Actual encrypted payload buffer: plaintext + overhead.
pub const DEFAULT_PAYLOAD_SIZE: usize = DEFAULT_PLAINTEXT_SIZE + PAYLOAD_OVERHEAD_SIZE; // 2065

/// Total on-the-wire size of a regular Sphinx packet.
pub const PACKET_SIZE: usize = HEADER_SIZE + DEFAULT_PAYLOAD_SIZE; // 2413

/// Lioness keys are 192 bytes by construction.
pub const PAYLOAD_KEY_SIZE: usize = 192;

/// Seed from which the 192-byte Lioness key is derived.
pub const PAYLOAD_KEY_SEED_SIZE: usize = SECURITY_PARAMETER; // 16

/// `hb` random-oracle output; a Curve25519 scalar.
pub const BLINDING_FACTOR_SIZE: usize = 2 * SECURITY_PARAMETER; // 32

/// `h_tau` output used by nodes to reject replays.
pub const REPLAY_TAG_SIZE: usize = 2 * SECURITY_PARAMETER; // 32

/// Layout of the HKDF output, in order:
/// stream_cipher_key || mac_key || payload_key || blinding_factor || replay_tag
pub const EXPANDED_SHARED_SECRET_LENGTH: usize = STREAM_CIPHER_KEY_SIZE
    + INTEGRITY_MAC_KEY_SIZE
    + PAYLOAD_KEY_SIZE
    + BLINDING_FACTOR_SIZE
    + REPLAY_TAG_SIZE; // 288

/// Nym's legacy HKDF info string (kept verbatim for compatibility).
pub const EXPANDED_SHARED_SECRET_HKDF_INFO: &[u8] =
    b"Dwste mou enan moxlo arketa makru kai ena upomoxlio gia na ton topothetisw kai tha kinisw thn gh.";
/// Nym uses an *empty* HKDF salt for legacy reasons.
pub const EXPANDED_SHARED_SECRET_HKDF_SALT: &[u8] = b"";

/// HKDF salt/info used to derive the final 192-byte Lioness key from the seed.
pub const PAYLOAD_KEY_HKDF_INFO: &[u8] = b"sphinx-payload-key-V01-CS01-HKDF:SHA256-INFO";
pub const PAYLOAD_KEY_HKDF_SALT: &[u8] = b"sphinx-payload-key-V01-CS01-HKDF:SHA256-SALT";
