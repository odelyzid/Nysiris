//! `nysiris` — the hosting CLI for Nysiris hidden services.
//!
//! ```sh
//! nysiris host echo                                   # trivial mixnet service
//! nysiris host files --web-root ./public              # static site over the mixnet
//! nysiris address --data-dir ./sp-storage             # print the stable address
//! nysiris fetch nym://<id>.<enc>@<gw>/ --path /       # client-side smoke test
//! nysiris petname add shop <id.enc@gw>                # local alias
//! nysiris doctor                                       # check config/state
//! ```
//!
//! The binary is the only nym-sdk-aware half of the SDK split; the reusable
//! library lives in `nysiris-sdk` (`docs/13-sdk-cli.md`).

mod args;
mod commands;
mod runtime;

use std::process::ExitCode;

/// Every command returns a human-readable error string; `main` prints it.
pub type CliResult<T> = Result<T, String>;

#[tokio::main]
async fn main() -> ExitCode {
    nym_bin_common::logging::setup_tracing_logger();

    let command = match args::parse(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(err) => {
            eprintln!("error: {err}\n");
            print_usage();
            return ExitCode::FAILURE;
        }
    };

    match commands::dispatch(command).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

pub(crate) fn print_usage() {
    println!(
        "\
nysiris {version} — host hidden services on the Nym mixnet

USAGE:
  nysiris host <echo|files> [options]     run a hidden service
  nysiris address [options]               print this host's stable Nym address
  nysiris fetch <address|petname> [opts]  request a hidden service and print the reply
  nysiris petname <action>                manage local-only names
  nysiris doctor [options]                validate config and local state
  nysiris help | version

COMMON OPTIONS:
  --data-dir DIR     mixnet storage (identity); default $NYSIRIS_DATA_DIR or ./sp-storage
  --gateway KEY      pin the service to a gateway identity for a stable address
  --ephemeral        use a throwaway identity (no stable address)

HOST:
  echo                                   built-in echo service
  files --web-root DIR [--index FILE] [--max-bytes N]
                                         serve a directory as a hidden website
  --label NAME                           log label (default: nysiris-service)
  --address-out FILE                     where to write the Nym address

FETCH:
  --method M --path P --body TEXT --timeout SECS --petnames FILE

PETNAME:
  add <name> <address> | list | remove <name> | resolve <name> [--file FILE]

See docs/13-sdk-cli.md for the library SDK and the full hosting guide.",
        version = env!("CARGO_PKG_VERSION")
    );
}
