# Fuzzing `sphinx-core`

Coverage-guided fuzzing of the packet and address parsers. This is **optional**:
the stable Rust test suite already includes a deterministic mutation/soak fuzzer
(`tests/fuzz_parser.rs` and `tests/soak.rs`), which runs in `./build.sh check`.

## Setup (requires a nightly toolchain)

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
```

## Run

```bash
cd crates/sphinx-core
cargo +nightly fuzz run parse_packet
```

Useful flags:

```bash
# time- or run-bounded
cargo +nightly fuzz run parse_packet -- -max_total_time=300
cargo +nightly fuzz run parse_packet -- -runs=1000000

# minimising a crashing input
cargo +nightly fuzz tmin parse_packet artifacts/parse_packet/<crash-file>
```

Corpus and crash artifacts land in `crates/sphinx-core/fuzz/corpus/` and
`crates/sphinx-core/fuzz/artifacts/`. Both are covered by `.gitignore`.

## What it checks

`SphinxPacket::from_bytes`, `SphinxHeader::from_bytes`, `Payload::from_bytes`
and `NymAddress::parse` must return `Ok`/`Err` for **any** input and must never
panic, index out of bounds, or loop unboundedly. The header MAC and the Lioness
wide-block payload cipher are what make the rest of the format safe against
tampering; the fuzzer is what gives confidence that malformed input cannot reach
those checks in a broken state.
