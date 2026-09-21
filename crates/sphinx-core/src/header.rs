//! Sphinx header construction and processing.
//!
//! This is the heart of the format. The mapping to the Danezis–Goldberg paper
//! is documented on every field:
//!
//! | Paper | Nym field | Location |
//! |-------|-----------|----------|
//! | `alpha` | `shared_secret` | first 32 bytes, a Curve25519 point |
//! | `beta`  | `enc_routing_information` | encrypted routing info |
//! | `gamma` | `integrity_mac` | truncated HMAC-SHA256 |
//! | `delta` | `payload` | Lioness-encrypted, see `payload.rs` |
//!
//! Key schedule (sender side), reproduced from `sphinx-packet::header::keys`:
//!
//! ```text
//! alpha_0 = g^r
//! acc_i   = (y_i) ^ (r * b_1 * ... * b_{i-1})     via repeated X25519
//! ess_i   = HKDF-SHA256(acc_i)                    -> 288 bytes
//! b_i     = ess_i.blinding_factor
//! alpha_i = b_{i-1} * alpha_{i-1}                 (node and sender agree)
//! ```

use crate::constants::*;
use crate::crypto::{
    compute_header_mac, derive_payload_key, generate_pseudorandom_bytes, mac_eq, xor, xor_with,
};
use crate::error::{SphinxError, SphinxResult};
use crate::route::{
    Delay, Destination, DestinationAddress, Node, NodeAddress, SurbIdentifier, Version,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// The 288-byte HKDF output for a single hop.
#[derive(Clone)]
pub struct ExpandedSharedSecret([u8; EXPANDED_SHARED_SECRET_LENGTH]);

impl ExpandedSharedSecret {
    /// `h_rho`: AES-128-CTR key protecting the routing information.
    pub fn stream_cipher_key(&self) -> &[u8; STREAM_CIPHER_KEY_SIZE] {
        self.0[0..STREAM_CIPHER_KEY_SIZE].try_into().unwrap()
    }

    /// `h_mu`: key for the truncated header MAC.
    pub fn header_integrity_mac_key(&self) -> &[u8; INTEGRITY_MAC_KEY_SIZE] {
        let start = STREAM_CIPHER_KEY_SIZE;
        self.0[start..start + INTEGRITY_MAC_KEY_SIZE]
            .try_into()
            .unwrap()
    }

    /// `h_pi`: seed for the 192-byte Lioness payload key.
    pub fn payload_key_seed(&self) -> &[u8; PAYLOAD_KEY_SEED_SIZE] {
        let start = STREAM_CIPHER_KEY_SIZE + INTEGRITY_MAC_KEY_SIZE;
        self.0[start..start + PAYLOAD_KEY_SEED_SIZE]
            .try_into()
            .unwrap()
    }

    /// `h_b`: the per-hop blinding factor scalar.
    pub fn blinding_factor_bytes(&self) -> &[u8; BLINDING_FACTOR_SIZE] {
        let start = STREAM_CIPHER_KEY_SIZE + INTEGRITY_MAC_KEY_SIZE + PAYLOAD_KEY_SIZE;
        self.0[start..start + BLINDING_FACTOR_SIZE]
            .try_into()
            .unwrap()
    }

    pub fn blinding_factor(&self) -> StaticSecret {
        StaticSecret::from(*self.blinding_factor_bytes())
    }

    /// `h_tau`: replay-detection tag (unused by this reference impl beyond
    /// being derived; production nodes feed it into a replay filter).
    pub fn replay_tag(&self) -> &[u8; REPLAY_TAG_SIZE] {
        let start = STREAM_CIPHER_KEY_SIZE
            + INTEGRITY_MAC_KEY_SIZE
            + PAYLOAD_KEY_SIZE
            + BLINDING_FACTOR_SIZE;
        self.0[start..start + REPLAY_TAG_SIZE].try_into().unwrap()
    }

    pub fn payload_key(&self) -> [u8; PAYLOAD_KEY_SIZE] {
        derive_payload_key(self.payload_key_seed())
    }
}

/// HKDF-SHA256 expansion of a raw X25519 shared secret.
pub fn expand_shared_secret(shared_secret: &[u8; 32]) -> ExpandedSharedSecret {
    let hkdf = Hkdf::<Sha256>::new(Some(EXPANDED_SHARED_SECRET_HKDF_SALT), shared_secret);
    let mut output = [0u8; EXPANDED_SHARED_SECRET_LENGTH];
    hkdf.expand(EXPANDED_SHARED_SECRET_HKDF_INFO, &mut output)
        .expect("288 bytes is a valid HKDF output length");
    ExpandedSharedSecret(output)
}

/// Sender-side key material for an entire route.
pub struct KeyMaterial {
    /// `alpha_0 = g^r`, transmitted in the clear.
    pub alpha: PublicKey,
    /// One expanded secret per hop.
    pub expanded: Vec<ExpandedSharedSecret>,
}

impl KeyMaterial {
    /// Derive all per-hop secrets and blinding factors. This is a direct port
    /// of Nym's `KeyMaterial::derive`.
    pub fn derive(route: &[Node], ephemeral: &StaticSecret) -> Self {
        let alpha = PublicKey::from(ephemeral);

        let mut blinding_factors: Vec<StaticSecret> = Vec::with_capacity(route.len());
        let mut expanded = Vec::with_capacity(route.len());

        for (i, node) in route.iter().enumerate() {
            // acc = X25519(b_{i-1}, ... X25519(b_1, X25519(r, y_i)))
            let mut acc = node.pub_key;
            for blinding_factor in std::iter::once(ephemeral).chain(blinding_factors.iter()) {
                let ss = blinding_factor.diffie_hellman(&acc);
                acc = PublicKey::from(ss.to_bytes());
            }

            let expanded_secret = expand_shared_secret(acc.as_bytes());

            // The final hop's blinding factor is never used (there is nowhere
            // to forward to), matching Nym's `if i != route.len() - 1`.
            if i != route.len() - 1 {
                blinding_factors.push(StaticSecret::from(*expanded_secret.blinding_factor_bytes()));
            }
            expanded.push(expanded_secret);
        }

        Self { alpha, expanded }
    }
}

/// Blind `alpha` forward using a hop's blinding factor.
fn blind_alpha(alpha: PublicKey, blinding_factor: &StaticSecret) -> PublicKey {
    PublicKey::from(blinding_factor.diffie_hellman(&alpha).to_bytes())
}

/// The Sphinx "filler" string. Reproduces `sphinx-packet::header::filler`.
struct Filler(Vec<u8>);

impl Filler {
    fn new(secrets: &[ExpandedSharedSecret]) -> Self {
        let mut accumulator: Vec<u8> = Vec::new();
        for (idx, secret) in secrets.iter().enumerate() {
            let i = idx + 1;
            let prg = generate_pseudorandom_bytes(
                secret.stream_cipher_key(),
                &STREAM_CIPHER_INIT_VECTOR,
                STREAM_CIPHER_OUTPUT_LENGTH,
            );
            // Grow by one (meta || mac) block, then XOR in the tail of the PRG.
            accumulator.extend(std::iter::repeat_n(0u8, FILLER_STEP_SIZE_INCREASE));
            let slice = &prg[prg.len() - i * FILLER_STEP_SIZE_INCREASE..];
            xor_with(&mut accumulator, slice);
        }
        Self(accumulator)
    }
}

impl From<Filler> for Vec<u8> {
    fn from(filler: Filler) -> Self {
        filler.0
    }
}

/// `gamma || beta`: the MAC and the encrypted routing information.
#[derive(Clone)]
pub struct EncapsulatedRoutingInfo {
    pub enc: [u8; ENCRYPTED_ROUTING_INFO_SIZE],
    pub mac: [u8; HEADER_INTEGRITY_MAC_SIZE],
}

/// The 348-byte Sphinx header.
#[derive(Clone)]
pub struct SphinxHeader {
    /// `alpha`, the ephemeral (blinded) Curve25519 public key.
    pub alpha: PublicKey,
    pub routing: EncapsulatedRoutingInfo,
}

/// What a node learns after removing its own layer.
// The `Forward` variant carries a full fixed-size Sphinx header; that is
// intentional (no allocation per hop), so the size difference is expected.
#[allow(clippy::large_enum_variant)]
pub enum ProcessedHeaderData {
    Forward {
        updated_header: SphinxHeader,
        next_hop: NodeAddress,
        delay: Delay,
    },
    Final {
        destination: DestinationAddress,
        identifier: SurbIdentifier,
    },
}

pub struct ProcessedHeader {
    pub payload_key: [u8; PAYLOAD_KEY_SIZE],
    pub data: ProcessedHeaderData,
}

impl SphinxHeader {
    /// Build a header for `route`, delivering to `destination`.
    ///
    /// `route` does **not** include the destination; it is the list of mix hops
    /// (and, in a real deployment, the entry gateway chosen as first hop).
    pub fn build(
        route: &[Node],
        delays: &[Delay],
        destination: &Destination,
        version: Version,
        rng: &mut impl RngCore,
    ) -> SphinxResult<(SphinxHeader, Vec<ExpandedSharedSecret>)> {
        if route.is_empty() {
            return Err(SphinxError::EmptyRoute);
        }
        if route.len() > MAX_PATH_LENGTH {
            return Err(SphinxError::RouteTooLong(route.len()));
        }
        if delays.len() != route.len() {
            return Err(SphinxError::DelayCountMismatch);
        }

        // Draw raw bytes rather than relying on `random_from_rng`, so the
        // builder only needs `RngCore` (not `CryptoRng`) and stays testable.
        let mut ephemeral_bytes = [0u8; 32];
        rng.fill_bytes(&mut ephemeral_bytes);
        let ephemeral = StaticSecret::from(ephemeral_bytes);
        let key_material = KeyMaterial::derive(route, &ephemeral);
        let secrets = &key_material.expanded;

        // Filler is built from all but the final hop's secrets.
        let filler: Vec<u8> = Filler::new(&secrets[..route.len() - 1]).into();

        // Innermost layer: the final recipient's routing block.
        let (mut enc, mut mac) = Self::build_final_hop(
            destination,
            secrets.last().expect("route is non-empty"),
            filler,
            route.len(),
            version,
            rng,
        );

        // Wrap outward: hop i tells hop i+1 where to go and how long to wait.
        for i in (0..route.len() - 1).rev() {
            let (next_enc, next_mac) = Self::build_forward_hop(
                route[i + 1].address,
                delays[i],
                &enc,
                &mac,
                &secrets[i],
                version,
            );
            enc = next_enc;
            mac = next_mac;
        }

        Ok((
            SphinxHeader {
                alpha: key_material.alpha,
                routing: EncapsulatedRoutingInfo { enc, mac },
            },
            key_material.expanded,
        ))
    }

    fn build_final_hop(
        destination: &Destination,
        last_secret: &ExpandedSharedSecret,
        filler: Vec<u8>,
        route_len: usize,
        version: Version,
        rng: &mut impl RngCore,
    ) -> (
        [u8; ENCRYPTED_ROUTING_INFO_SIZE],
        [u8; HEADER_INTEGRITY_MAC_SIZE],
    ) {
        // Length of the final plaintext before the filler is appended.
        let padded_len = ENCRYPTED_ROUTING_INFO_SIZE - FILLER_STEP_SIZE_INCREASE * (route_len - 1);

        let mut plaintext = Vec::with_capacity(padded_len);
        plaintext.push(FINAL_HOP);
        plaintext.extend_from_slice(&version.to_bytes());
        plaintext.extend_from_slice(destination.address.as_bytes());
        plaintext.extend_from_slice(&destination.identifier);

        // Random padding, not zeros: this is Nym's mitigation for the Kuhn et
        // al. attack on deterministic Sphinx padding.
        let pad_len = padded_len - FINAL_NODE_META_INFO_LENGTH;
        let mut padding = vec![0u8; pad_len];
        rng.fill_bytes(&mut padding);
        plaintext.extend_from_slice(&padding);
        debug_assert_eq!(plaintext.len(), padded_len);

        let keystream = generate_pseudorandom_bytes(
            last_secret.stream_cipher_key(),
            &STREAM_CIPHER_INIT_VECTOR,
            STREAM_CIPHER_OUTPUT_LENGTH,
        );
        let mut enc = xor(&plaintext, &keystream[..padded_len]);
        enc.extend_from_slice(&filler);
        debug_assert_eq!(enc.len(), ENCRYPTED_ROUTING_INFO_SIZE);

        let mut enc_array = [0u8; ENCRYPTED_ROUTING_INFO_SIZE];
        enc_array.copy_from_slice(&enc);

        let mac = compute_header_mac(last_secret.header_integrity_mac_key(), &enc_array);
        (enc_array, mac)
    }

    fn build_forward_hop(
        next_hop: NodeAddress,
        delay: Delay,
        next_enc: &[u8; ENCRYPTED_ROUTING_INFO_SIZE],
        next_mac: &[u8; HEADER_INTEGRITY_MAC_SIZE],
        secret: &ExpandedSharedSecret,
        version: Version,
    ) -> (
        [u8; ENCRYPTED_ROUTING_INFO_SIZE],
        [u8; HEADER_INTEGRITY_MAC_SIZE],
    ) {
        let mut plaintext = Vec::with_capacity(ENCRYPTED_ROUTING_INFO_SIZE);
        plaintext.push(FORWARD_HOP);
        plaintext.extend_from_slice(&version.to_bytes());
        plaintext.extend_from_slice(next_hop.as_bytes());
        plaintext.extend_from_slice(&delay.to_bytes());
        plaintext.extend_from_slice(next_mac);
        plaintext.extend_from_slice(&next_enc[..TRUNCATED_ROUTING_INFO_SIZE]);
        debug_assert_eq!(plaintext.len(), ENCRYPTED_ROUTING_INFO_SIZE);

        let keystream = generate_pseudorandom_bytes(
            secret.stream_cipher_key(),
            &STREAM_CIPHER_INIT_VECTOR,
            STREAM_CIPHER_OUTPUT_LENGTH,
        );
        let encrypted = xor(&plaintext, &keystream[..ENCRYPTED_ROUTING_INFO_SIZE]);

        let mut enc = [0u8; ENCRYPTED_ROUTING_INFO_SIZE];
        enc.copy_from_slice(&encrypted);
        let mac = compute_header_mac(secret.header_integrity_mac_key(), &enc);
        (enc, mac)
    }

    /// Process this header with a hop's long-term X25519 secret key.
    ///
    /// On success the caller learns either where to forward the packet next
    /// (and how long to delay) or, at the final hop, the destination and
    /// identifier. In both cases it also learns the payload key for that layer.
    pub fn process(&self, node_secret: &StaticSecret) -> SphinxResult<ProcessedHeader> {
        let shared_secret = node_secret.diffie_hellman(&self.alpha);
        let expanded = expand_shared_secret(shared_secret.as_bytes());

        // gamma check: reject tampered headers before doing any decryption work.
        let expected_mac =
            compute_header_mac(expanded.header_integrity_mac_key(), &self.routing.enc);
        if !mac_eq(&expected_mac, &self.routing.mac) {
            return Err(SphinxError::InvalidHeaderMac);
        }

        // Decrypt 300 bytes of beta and 60 bytes of zero padding back into a
        // 360-byte routing block.
        let keystream = generate_pseudorandom_bytes(
            expanded.stream_cipher_key(),
            &STREAM_CIPHER_INIT_VECTOR,
            STREAM_CIPHER_OUTPUT_LENGTH,
        );
        let mut plaintext = vec![0u8; STREAM_CIPHER_OUTPUT_LENGTH];
        plaintext[..ENCRYPTED_ROUTING_INFO_SIZE].copy_from_slice(&self.routing.enc);
        xor_with(&mut plaintext, &keystream);

        let payload_key = expanded.payload_key();

        match plaintext[0] {
            FORWARD_HOP => {
                let version = Version::from_bytes(plaintext[1..4].try_into().unwrap());
                let _ = version; // version-gated behaviour would branch here
                let next_hop = NodeAddress::from_bytes(
                    plaintext[4..4 + NODE_ADDRESS_LENGTH].try_into().unwrap(),
                );
                let delay_bytes: [u8; DELAY_LENGTH] = plaintext
                    [4 + NODE_ADDRESS_LENGTH..4 + NODE_ADDRESS_LENGTH + DELAY_LENGTH]
                    .try_into()
                    .unwrap();
                let delay = Delay::from_bytes(delay_bytes);

                let mac_start = 4 + NODE_ADDRESS_LENGTH + DELAY_LENGTH;
                let next_mac: [u8; HEADER_INTEGRITY_MAC_SIZE] = plaintext
                    [mac_start..mac_start + HEADER_INTEGRITY_MAC_SIZE]
                    .try_into()
                    .unwrap();
                let enc_start = mac_start + HEADER_INTEGRITY_MAC_SIZE;
                let mut next_enc = [0u8; ENCRYPTED_ROUTING_INFO_SIZE];
                next_enc.copy_from_slice(
                    &plaintext[enc_start..enc_start + ENCRYPTED_ROUTING_INFO_SIZE],
                );

                let updated_header = SphinxHeader {
                    alpha: blind_alpha(self.alpha, &expanded.blinding_factor()),
                    routing: EncapsulatedRoutingInfo {
                        enc: next_enc,
                        mac: next_mac,
                    },
                };

                Ok(ProcessedHeader {
                    payload_key,
                    data: ProcessedHeaderData::Forward {
                        updated_header,
                        next_hop,
                        delay,
                    },
                })
            }
            FINAL_HOP => {
                let destination = DestinationAddress::from_bytes(
                    plaintext[4..4 + DESTINATION_ADDRESS_LENGTH]
                        .try_into()
                        .unwrap(),
                );
                let id_start = 4 + DESTINATION_ADDRESS_LENGTH;
                let identifier: [u8; IDENTIFIER_LENGTH] = plaintext
                    [id_start..id_start + IDENTIFIER_LENGTH]
                    .try_into()
                    .unwrap();

                Ok(ProcessedHeader {
                    payload_key,
                    data: ProcessedHeaderData::Final {
                        destination,
                        identifier,
                    },
                })
            }
            flag => Err(SphinxError::UnknownRoutingFlag(flag)),
        }
    }

    /// Serialise as `alpha || gamma || beta` (348 bytes).
    pub fn to_bytes(&self) -> [u8; HEADER_SIZE] {
        let mut out = [0u8; HEADER_SIZE];
        out[..32].copy_from_slice(self.alpha.as_bytes());
        out[32..32 + HEADER_INTEGRITY_MAC_SIZE].copy_from_slice(&self.routing.mac);
        out[32 + HEADER_INTEGRITY_MAC_SIZE..].copy_from_slice(&self.routing.enc);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> SphinxResult<Self> {
        if bytes.len() != HEADER_SIZE {
            return Err(SphinxError::InvalidHeaderLength(bytes.len()));
        }
        let alpha_bytes: [u8; 32] = bytes[..32].try_into().unwrap();
        let mut mac = [0u8; HEADER_INTEGRITY_MAC_SIZE];
        mac.copy_from_slice(&bytes[32..32 + HEADER_INTEGRITY_MAC_SIZE]);
        let mut enc = [0u8; ENCRYPTED_ROUTING_INFO_SIZE];
        enc.copy_from_slice(&bytes[32 + HEADER_INTEGRITY_MAC_SIZE..]);
        Ok(SphinxHeader {
            alpha: PublicKey::from(alpha_bytes),
            routing: EncapsulatedRoutingInfo { enc, mac },
        })
    }
}
