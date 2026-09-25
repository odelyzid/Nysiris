# nysiris CLI

The `nysiris` binary hosts hidden services on the Nym mixnet and manages the
operator-side state around them. It is the nym-sdk-aware half of the hosting
SDK; the reusable library is [`crates/nysiris-sdk/`](../../crates/nysiris-sdk/).
Full reference: [`docs/13-sdk-cli.md`](../../docs/13-sdk-cli.md).

## Build

```sh
# from the repo root
./build.sh services nysiris-cli

# or directly
cd services/nysiris-cli
cargo build --release            # -> target/release/nysiris
```

## Commands

```sh
nysiris host echo [--data-dir DIR] [--gateway KEY] [--label NAME] [--address-out FILE]
nysiris host files --web-root DIR [--index FILE] [--max-bytes N] [options]
nysiris address [--data-dir DIR] [--gateway KEY] [--out FILE] [--ephemeral]
nysiris fetch <address|petname> [--method M] [--path P] [--body TEXT] [--timeout SECS]
                                 [--petnames FILE] [--data-dir DIR] [--gateway KEY] [--ephemeral]
nysiris petname <add NAME ADDRESS|list|remove NAME|resolve NAME> [--file FILE]
nysiris doctor [--data-dir DIR] [--gateway KEY]
nysiris help | version
```

`--ephemeral` uses a throwaway identity (no stable address). Persistent storage
(`--data-dir`, default `$NYSIRIS_DATA_DIR` or `./sp-storage`) is what keeps the
address stable across restarts — back it up.

## Example: host and reach a hidden service

```sh
# terminal 1
nysiris host files --web-root ./public
# prints: <id>.<enc>@<gw>  (also written to ./sp-storage/nym-address.txt)

# terminal 2
nysiris fetch <id>.<enc>@<gw> --path /
nysiris fetch <id>.<enc>@<gw> --method POST --path /echo --body hello
```

The service opens **no inbound port**: it dials out to a gateway and replies
over the client's SURBs. See
[`docs/04-hosting-services.md`](../../docs/04-hosting-services.md).

## Limits

Messaging is request/response, not streaming. One Sphinx message carries
roughly 2 KB, so `host files` caps bodies at one packet
(`nysiris_sdk::files::MAX_ONE_PACKET_BODY`, 1400 raw bytes) and returns `413`
for larger files until chunked transfer is wired.
