//! CLI subcommands.

pub mod address;
pub mod doctor;
pub mod fetch;
pub mod host;
pub mod petname;

use std::path::PathBuf;

use nysiris_sdk::HostConfig;

use crate::args::{Command, CommonArgs};
use crate::CliResult;

/// Start from environment defaults, then apply command-line overrides, so
/// flags always win over `NYSIRIS_*` / `SP_*` variables.
pub fn host_config(common: &CommonArgs) -> HostConfig {
    let mut config = HostConfig::from_env();
    if let Some(data_dir) = &common.data_dir {
        config.data_dir = PathBuf::from(data_dir);
    }
    if let Some(gateway) = &common.gateway {
        config.gateway = Some(gateway.clone());
    }
    config
}

pub async fn dispatch(command: Command) -> CliResult<()> {
    match command {
        Command::Host(args) => host::run(args).await,
        Command::Address(args) => address::run(args).await,
        Command::Fetch(args) => fetch::run(args).await,
        Command::Petname(args) => petname::run(args),
        Command::Doctor(args) => doctor::run(args),
        Command::Help => {
            crate::print_usage();
            Ok(())
        }
        Command::Version => {
            println!("nysiris {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
    }
}
