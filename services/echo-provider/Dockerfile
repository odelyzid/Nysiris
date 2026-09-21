# Build (nym-sdk is large; first build can take several minutes).
FROM rust:1.94-bookworm AS builder
WORKDIR /src
COPY Cargo.toml ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/target/release/echo-provider /usr/local/bin/echo-provider
# Provider storage holds the identity keys: mount a volume to keep the address.
ENV SP_DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/echo-provider"]
