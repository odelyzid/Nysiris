//! `nysiris doctor` — validate configuration and local state without touching
//! the network.

use nysiris_sdk::PetnameRegistry;

use crate::args::DoctorArgs;
use crate::commands::host_config;
use crate::CliResult;

pub fn run(args: DoctorArgs) -> CliResult<()> {
    let config = host_config(&args.common);

    println!("nysiris {}", env!("CARGO_PKG_VERSION"));
    println!("data dir:   {}", config.data_dir.display());
    match std::fs::create_dir_all(&config.data_dir) {
        Ok(()) => println!("storage:    ok (writable)"),
        Err(err) => println!("storage:    NOT writable ({err})"),
    }
    match &config.gateway {
        Some(gateway) => println!("gateway:    pinned to {gateway}"),
        None => println!("gateway:    (automatic; pin one for a guaranteed-stable address)"),
    }

    let address_path = config.address_path();
    println!("address:    {}", address_path.display());
    match config.stored_address() {
        Ok(uri) => println!("            {uri}"),
        Err(_) => println!("            (none yet; run `nysiris address`)"),
    }

    let petnames = config.data_dir.join("petnames.json");
    print!("petnames:   {}", petnames.display());
    if petnames.exists() {
        match PetnameRegistry::load(&petnames) {
            Ok(registry) => println!(" ({} entries)", registry.len()),
            Err(err) => println!(" INVALID ({err})"),
        }
    } else {
        println!(" (none)");
    }

    println!("services:   echo, files");
    Ok(())
}
