//! Tests for the hidden-service abstraction (`docs/08-hidden-services.md`).
use std::collections::HashMap;

use nym_hidden_service::{
    chunk, dispatch,
    envelope::{Request, Response},
    petnames::PetnameRegistry,
    service::EchoService,
    uri::NymUri,
};

fn sample_uri() -> NymUri {
    NymUri {
        identity: [1u8; 32],
        encryption: [2u8; 32],
        gateway: [3u8; 32],
    }
}

#[test]
fn uri_round_trips_with_and_without_scheme() {
    let uri = sample_uri();
    let encoded = uri.encode();
    let with_scheme = uri.to_uri();
    assert!(with_scheme.starts_with("nym://"));
    assert_eq!(NymUri::parse(&encoded).unwrap(), uri);
    assert_eq!(NymUri::parse(&with_scheme).unwrap(), uri);
    assert_eq!(uri.to_string(), with_scheme);
}

#[test]
fn uri_rejects_garbage() {
    for bad in ["", "nym://", "nope", "a.b", "a.b@c", "nym://a.b@c.d"] {
        assert!(NymUri::parse(bad).is_err(), "{bad:?} must be rejected");
    }
    // Wrong key length: 31 zero bytes is not a key.
    let short = bs58_like([0u8; 31]);
    assert!(NymUri::parse(&format!("{short}.{short}@{short}")).is_err());
}

fn bs58_like(bytes: impl AsRef<[u8]>) -> String {
    bs58::encode(bytes).into_string()
}

#[test]
fn envelope_validates_up_front() {
    let ok = Request::new("GET", "/api/status", HashMap::new(), b"hi").unwrap();
    assert_eq!(ok.method, "GET");
    assert_eq!(ok.body().unwrap(), b"hi");
    let json = ok.to_json();
    assert_eq!(Request::from_json(json.as_bytes()).unwrap(), ok);

    assert!(Request::new("TRACE", "/", HashMap::new(), &[]).is_err());
    assert!(Request::new("GET", "/../etc", HashMap::new(), &[]).is_err());
    assert!(Request::new("GET", "https://evil/", HashMap::new(), &[]).is_err());
    let big = vec![0u8; 128 * 1024];
    assert!(Request::new("POST", "/", HashMap::new(), &big).is_err());
}

#[test]
fn dispatch_serves_and_never_panics_on_garbage() {
    let svc = EchoService;
    let req = Request::new("GET", "/hello", HashMap::new(), b"world").unwrap();
    let reply = Response::from_json(&dispatch(&svc, req.to_json().as_bytes())).unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body().unwrap(), b"echo [GET /hello]: world");

    for garbage in [b"{}".to_vec(), b"not json".to_vec(), vec![], vec![0xff; 64]] {
        let reply = Response::from_json(&dispatch(&svc, &garbage)).unwrap();
        assert!(reply.status >= 400, "garbage must become an error reply");
        assert!(reply.error.is_some());
    }
}

#[test]
fn petnames_resolve_locally_and_persist() {
    let mut reg = PetnameRegistry::new();
    let uri = sample_uri();
    reg.insert("Shop", uri).unwrap();
    assert_eq!(reg.resolve("shop").unwrap(), uri);
    assert_eq!(reg.resolve("SHOP").unwrap(), uri);
    // Falls back to direct URI parsing.
    assert_eq!(reg.resolve(&uri.to_uri()).unwrap(), uri);
    // Re-binding the same address is idempotent; a different one is refused.
    reg.insert("shop", uri).unwrap();
    let other = NymUri {
        encryption: [9u8; 32],
        ..uri
    };
    assert!(reg.insert("shop", other).is_err());
    assert!(reg.insert("", uri).is_err());
    assert!(reg.insert("has space", uri).is_err());
    // Tooling lists the local registry without publishing it.
    let listed: Vec<&str> = reg.iter().map(|(name, _)| name).collect();
    assert_eq!(listed, vec!["shop"]);

    let dir = std::env::temp_dir().join("fly-petnames-test.json");
    reg.save(&dir).unwrap();
    let loaded = PetnameRegistry::load(&dir).unwrap();
    assert_eq!(loaded.resolve("shop").unwrap(), uri);
    let _ = std::fs::remove_file(&dir);
}

#[test]
fn chunks_split_and_rejoin() {
    assert!(chunk::split(&[], 10).unwrap().is_empty());
    let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    let parts = chunk::split(&data, 2000).unwrap();
    assert_eq!(parts.len(), 3);
    assert_eq!(chunk::count(5000, 2000).unwrap(), 3);
    assert_eq!(chunk::join(&parts), data);
}

#[test]
fn chunk_helpers_reject_zero_and_never_panic() {
    assert!(chunk::split(&[1, 2, 3], 0).is_err());
    assert!(chunk::count(0, 0).is_err());
}

#[test]
fn documented_limits_are_stable() {
    assert_eq!(
        nym_hidden_service::envelope::DEFAULT_MAX_BODY_BYTES,
        64 * 1024
    );
}

#[test]
fn invite_sign_verify_link_round_trip() {
    use nym_hidden_service::Invite;

    let service = sample_uri();
    let sk = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
    let invite = Invite::sign_new(&sk, &service, "ada's book club").unwrap();

    // Compact form survives encode/decode and verifies against the link address.
    let compact = invite.encode_compact();
    assert!(!compact.contains('+') && !compact.contains('/') && !compact.contains('='));
    let back = Invite::decode_compact(&compact).unwrap();
    assert_eq!(back, invite);
    back.verify_against(&service).unwrap();

    // Full link form.
    let link = invite.to_link(&service);
    assert!(link.starts_with("nym://"));
    assert!(link.contains("#invite="));
}

#[test]
fn invite_rejects_bait_and_switch_forgery_and_garbage() {
    use nym_hidden_service::{Invite, InviteError};

    let service = sample_uri();
    let sk = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
    let invite = Invite::sign_new(&sk, &service, "hello").unwrap();

    // Different link address: bait-and-switch refused.
    let other = NymUri {
        gateway: [9u8; 32],
        ..service
    };
    assert_eq!(
        invite.verify_against(&other).unwrap_err(),
        InviteError::ServiceMismatch
    );

    // Tampered note fails signature verification.
    let mut forged = invite.clone();
    forged.note = "mallory was here".into();
    assert!(matches!(
        forged.verify_against(&service).unwrap_err(),
        InviteError::BadSignature(_)
    ));

    // Empty/oversize notes refused at signing time.
    assert!(Invite::sign_new(&sk, &service, "").is_err());
    assert!(Invite::sign_new(&sk, &service, &"x".repeat(141)).is_err());

    // Garbage compact forms refused.
    assert!(Invite::decode_compact("!!!").is_err());
    assert!(Invite::decode_compact("").is_err());
}

#[test]
fn verifies_typescript_signed_invite() {
    use nym_hidden_service::Invite;

    // Signed by @noble/curves (TypeScript) with privkey [42; 32].
    // If this fails, the two signing layouts have diverged.
    let service = "nym://4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi.8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR@CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
    let invite = Invite {
        service: service.into(),
        inviter: "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61".into(),
        note: "cross-impl check".into(),
        sig: "6835db7d6a70b467c66fc7a658332ff52a7b6ee2b2d8e884a85dcb5f80df0f2cb93da6604b67af6da1324f2c3363377a4678218885d1a64d335f288a39570b04".into(),
    };
    let link_service = nym_hidden_service::NymUri::parse(service).unwrap();
    invite.verify_against(&link_service).unwrap();
}
