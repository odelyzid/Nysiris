# NOTE: build context is the REPO ROOT (set in docker-compose* files), because
# hybrid-bridge depends on ../../crates/bridge-guard via a Cargo path
# dependency. Building with the service directory as context cannot see it.
FROM rust:1.94-bookworm AS builder
WORKDIR /build
COPY services/hybrid-bridge/Cargo.toml ./services/hybrid-bridge/Cargo.toml
COPY crates/bridge-guard ./crates/bridge-guard
WORKDIR /build/services/hybrid-bridge
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY services/hybrid-bridge/src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/services/hybrid-bridge/target/release/hybrid-bridge /usr/local/bin/hybrid-bridge
ENV SP_DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/hybrid-bridge"]
