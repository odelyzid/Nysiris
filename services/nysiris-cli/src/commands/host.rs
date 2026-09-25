//! `nysiris host` — run a built-in hidden service until interrupted.

use nysiris_sdk::files::{DEFAULT_INDEX, MAX_ONE_PACKET_BODY};
use nysiris_sdk::{
    serve, EchoService, HiddenService, MixnetRuntime, NymUri, Request, Response, StaticFiles,
};

use crate::args::{HostArgs, ServiceKind};
use crate::commands::host_config;
use crate::runtime::{self, MixnetClientRuntime};
use crate::CliResult;

/// The hosted service, resolved from the chosen [`ServiceKind`].
enum Hosted {
    Echo(EchoService),
    Files(StaticFiles),
}

impl HiddenService for Hosted {
    fn handle(&self, request: &Request) -> Response {
        match self {
            Hosted::Echo(service) => service.handle(request),
            Hosted::Files(service) => service.handle(request),
        }
    }
}

pub async fn run(args: HostArgs) -> CliResult<()> {
    let mut config = host_config(&args.common);
    if let Some(label) = &args.label {
        config.label = label.clone();
    }
    if let Some(out) = &args.address_out {
        config.address_file = Some(out.into());
    }
    // An ephemeral host has no stable address to publish.
    if args.ephemeral {
        config.write_address_file = false;
    }

    let service = build_service(&args)?;

    if let Some(gateway) = &config.gateway {
        println!("pinning service to gateway {gateway}");
    }
    println!("using storage {}", config.data_dir.display());
    eprintln!("connecting to the mixnet (this can take a few seconds)…");

    let client = runtime::connect(&config, args.ephemeral).await?;
    let address = *client.nym_address();
    println!("\n{} Nym address:\n{address}\n", config.label);

    if config.write_address_file {
        let uri = NymUri::parse(&address.to_string()).map_err(|e| e.to_string())?;
        match config.write_address(&uri) {
            Ok(path) => println!("address written to {}", path.display()),
            Err(err) => eprintln!("warning: could not write the address file: {err}"),
        }
    }

    let mut runtime = MixnetClientRuntime::new(client);
    let mut serving = Box::pin(serve(&mut runtime, &service));
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            println!("shutdown signal received");
            drop(serving);
            runtime.disconnect().await;
        }
        _ = &mut serving => {}
    }
    Ok(())
}

fn build_service(args: &HostArgs) -> CliResult<Hosted> {
    match args.service {
        ServiceKind::Echo => Ok(Hosted::Echo(EchoService)),
        ServiceKind::Files => {
            let root = args
                .web_root
                .clone()
                .ok_or("`nysiris host files` requires --web-root <dir>")?;
            let index = args
                .index
                .clone()
                .unwrap_or_else(|| DEFAULT_INDEX.to_string());
            let max_bytes = args.max_bytes.unwrap_or(MAX_ONE_PACKET_BODY);
            if max_bytes > MAX_ONE_PACKET_BODY {
                eprintln!(
                    "warning: --max-bytes {max_bytes} exceeds one mixnet message \
                     ({MAX_ONE_PACKET_BODY} bytes); oversized replies will be dropped"
                );
            }
            let service = StaticFiles::with_options(root, index.clone(), max_bytes)?;
            println!("serving {} (index {index})", service.root().display());
            Ok(Hosted::Files(service))
        }
    }
}
