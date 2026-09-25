//! `nysiris address` — connect with the stored identity and print its stable
//! Nym address, persisting it for out-of-band distribution.

use nysiris_sdk::NymUri;

use crate::args::AddressArgs;
use crate::commands::host_config;
use crate::runtime;
use crate::CliResult;

pub async fn run(args: AddressArgs) -> CliResult<()> {
    let mut config = host_config(&args.common);
    if let Some(out) = &args.out {
        config.address_file = Some(out.into());
    }
    if args.ephemeral {
        config.write_address_file = false;
    }

    eprintln!("connecting to the mixnet (this can take a few seconds)…");
    let client = runtime::connect(&config, args.ephemeral).await?;
    let address = *client.nym_address();
    println!("{address}");

    if config.write_address_file {
        let uri = NymUri::parse(&address.to_string()).map_err(|e| e.to_string())?;
        match config.write_address(&uri) {
            Ok(path) => eprintln!("address written to {}", path.display()),
            Err(err) => eprintln!("warning: could not write the address file: {err}"),
        }
    }

    client.disconnect().await;
    Ok(())
}
