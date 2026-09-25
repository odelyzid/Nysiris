//! `nysiris petname` — manage the local-only human-name registry.
//!
//! Petnames never leave the machine (`docs/08-hidden-services.md` §8.5): there
//! is deliberately no global directory to publish into.

use std::path::{Path, PathBuf};

use nysiris_sdk::{HostConfig, NymUri, PetnameRegistry};

use crate::args::{PetnameAction, PetnameArgs};
use crate::CliResult;

pub fn run(args: PetnameArgs) -> CliResult<()> {
    let path = args.file.clone().unwrap_or_else(default_path);
    let path = PathBuf::from(path);
    let mut registry = if path.exists() {
        PetnameRegistry::load(&path)?
    } else {
        PetnameRegistry::new()
    };

    match args.action {
        PetnameAction::Add { name, address } => {
            let uri = NymUri::parse(&address).map_err(|e| e.to_string())?;
            registry.insert(&name, uri)?;
            registry.save(&path)?;
            println!("{name} -> {uri}");
        }
        PetnameAction::Remove { name } => {
            if registry.remove(&name) {
                registry.save(&path)?;
                println!("removed {name}");
            } else {
                println!("no petname named {name} in {}", path.display());
            }
        }
        PetnameAction::Resolve { name } => {
            println!("{}", registry.resolve(&name)?);
        }
        PetnameAction::List => {
            if registry.is_empty() {
                println!("(no petnames in {})", path.display());
                return Ok(());
            }
            let mut rows: Vec<(String, String)> = registry
                .iter()
                .map(|(name, uri)| (name.to_string(), uri.to_string()))
                .collect();
            rows.sort();
            for (name, uri) in rows {
                println!("{name}\t{uri}");
            }
        }
    }
    Ok(())
}

fn default_path() -> String {
    let config = HostConfig::from_env();
    Path::new(&config.data_dir)
        .join("petnames.json")
        .to_string_lossy()
        .into_owned()
}
