//! Command-line parsing, hand-rolled so the binary carries no extra dependency
//! and every branch is unit-testable without touching the network.
//!
//! Usage (see `nysiris help`):
//!
//! ```text
//! nysiris host <echo|files> [--data-dir DIR] [--gateway KEY] [--label NAME]
//!                          [--address-out FILE] [--ephemeral]
//!                          [files: --web-root DIR --index FILE --max-bytes N]
//! nysiris address [--data-dir DIR] [--gateway KEY] [--out FILE] [--ephemeral]
//! nysiris fetch <address|petname> [--path P] [--method M] [--body TEXT]
//!                                [--timeout SECS] [--petnames FILE]
//!                                [--data-dir DIR] [--gateway KEY] [--ephemeral]
//! nysiris petname <add NAME ADDRESS|list|remove NAME|resolve NAME> [--file FILE]
//! nysiris doctor [--data-dir DIR] [--gateway KEY]
//! ```

/// A parsed invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Host(HostArgs),
    Address(AddressArgs),
    Fetch(FetchArgs),
    Petname(PetnameArgs),
    Doctor(DoctorArgs),
    Help,
    Version,
}

/// Storage/gateway options shared by the commands that talk to the mixnet.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommonArgs {
    pub data_dir: Option<String>,
    pub gateway: Option<String>,
}

/// Built-in service to host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceKind {
    Echo,
    Files,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostArgs {
    pub common: CommonArgs,
    pub service: ServiceKind,
    pub label: Option<String>,
    pub address_out: Option<String>,
    pub ephemeral: bool,
    pub web_root: Option<String>,
    pub index: Option<String>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressArgs {
    pub common: CommonArgs,
    pub out: Option<String>,
    pub ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchArgs {
    pub target: String,
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    pub timeout_secs: u64,
    pub petnames: Option<String>,
    pub common: CommonArgs,
    pub ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PetnameArgs {
    pub action: PetnameAction,
    pub file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PetnameAction {
    Add { name: String, address: String },
    List,
    Remove { name: String },
    Resolve { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorArgs {
    pub common: CommonArgs,
}

/// Parse the arguments after the program name.
pub fn parse<I, S>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let items: Vec<String> = args.into_iter().map(Into::into).collect();
    let mut iter = items.iter();
    let Some(command) = iter.next() else {
        return Ok(Command::Help);
    };
    let rest: Vec<&str> = iter.map(String::as_str).collect();
    match command.as_str() {
        "host" => parse_host(&rest).map(Command::Host),
        "address" => parse_address(&rest).map(Command::Address),
        "fetch" => parse_fetch(&rest).map(Command::Fetch),
        "petname" | "petnames" => parse_petname(&rest).map(Command::Petname),
        "doctor" => parse_doctor(&rest).map(Command::Doctor),
        "help" | "--help" | "-h" => Ok(Command::Help),
        "version" | "--version" | "-V" => Ok(Command::Version),
        other => Err(format!("unknown command `{other}` (try `nysiris help`)")),
    }
}

/// Minimal, allocation-friendly option cursor.
struct Cursor<'a> {
    args: Vec<&'a str>,
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(args: &[&'a str]) -> Self {
        Self {
            args: args.to_vec(),
            pos: 0,
        }
    }

    fn next(&mut self) -> Option<&'a str> {
        let value = self.args.get(self.pos).copied();
        if value.is_some() {
            self.pos += 1;
        }
        value
    }

    /// Consume the next token as the value of `flag`, rejecting a following
    /// flag so `--path --method GET` fails loudly instead of silently.
    fn value(&mut self, flag: &str) -> Result<&'a str, String> {
        let value = self
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?;
        if value.starts_with("--") {
            return Err(format!("{flag} requires a value, got option `{value}`"));
        }
        Ok(value)
    }
}

/// Common options; returns `true` when `arg` was consumed.
fn parse_common(
    cursor: &mut Cursor<'_>,
    common: &mut CommonArgs,
    arg: &str,
) -> Result<bool, String> {
    match arg {
        "--data-dir" => {
            common.data_dir = Some(cursor.value("--data-dir")?.to_string());
            Ok(true)
        }
        "--gateway" => {
            common.gateway = Some(cursor.value("--gateway")?.to_string());
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn parse_host(args: &[&str]) -> Result<HostArgs, String> {
    let mut cursor = Cursor::new(args);
    let service = match cursor.next() {
        Some("echo") => ServiceKind::Echo,
        Some("files") => ServiceKind::Files,
        Some(other) => {
            return Err(format!(
                "unknown service `{other}` (expected `echo` or `files`)"
            ))
        }
        None => return Err("usage: nysiris host <echo|files> [options]".into()),
    };
    let mut host = HostArgs {
        common: CommonArgs::default(),
        service,
        label: None,
        address_out: None,
        ephemeral: false,
        web_root: None,
        index: None,
        max_bytes: None,
    };
    while let Some(arg) = cursor.next() {
        if parse_common(&mut cursor, &mut host.common, arg)? {
            continue;
        }
        match arg {
            "--label" => host.label = Some(cursor.value("--label")?.to_string()),
            "--address-out" => host.address_out = Some(cursor.value("--address-out")?.to_string()),
            "--ephemeral" => host.ephemeral = true,
            "--web-root" | "--dir" => host.web_root = Some(cursor.value("--web-root")?.to_string()),
            "--index" => host.index = Some(cursor.value("--index")?.to_string()),
            "--max-bytes" => {
                let raw = cursor.value("--max-bytes")?;
                host.max_bytes = Some(
                    raw.parse()
                        .map_err(|_| format!("--max-bytes must be a number, got `{raw}`"))?,
                );
            }
            other => return Err(format!("unknown option `{other}` for `host`")),
        }
    }
    if service == ServiceKind::Files && host.web_root.is_none() {
        return Err("`nysiris host files` requires --web-root <dir>".into());
    }
    Ok(host)
}

fn parse_address(args: &[&str]) -> Result<AddressArgs, String> {
    let mut parsed = AddressArgs {
        common: CommonArgs::default(),
        out: None,
        ephemeral: false,
    };
    let mut cursor = Cursor::new(args);
    while let Some(arg) = cursor.next() {
        if parse_common(&mut cursor, &mut parsed.common, arg)? {
            continue;
        }
        match arg {
            "--out" => parsed.out = Some(cursor.value("--out")?.to_string()),
            "--ephemeral" => parsed.ephemeral = true,
            other => return Err(format!("unknown option `{other}` for `address`")),
        }
    }
    Ok(parsed)
}

fn parse_fetch(args: &[&str]) -> Result<FetchArgs, String> {
    let mut cursor = Cursor::new(args);
    let target = match cursor.next() {
        Some(target) if !target.starts_with("--") => target.to_string(),
        _ => return Err("usage: nysiris fetch <nym-address|petname> [options]".into()),
    };
    let mut parsed = FetchArgs {
        target,
        method: "GET".to_string(),
        path: "/".to_string(),
        body: None,
        timeout_secs: 60,
        petnames: None,
        common: CommonArgs::default(),
        ephemeral: false,
    };
    while let Some(arg) = cursor.next() {
        if parse_common(&mut cursor, &mut parsed.common, arg)? {
            continue;
        }
        match arg {
            "--method" => parsed.method = cursor.value("--method")?.to_ascii_uppercase(),
            "--path" => parsed.path = cursor.value("--path")?.to_string(),
            "--body" => parsed.body = Some(cursor.value("--body")?.to_string()),
            "--timeout" => {
                let raw = cursor.value("--timeout")?;
                parsed.timeout_secs = raw
                    .parse()
                    .map_err(|_| format!("--timeout must be seconds, got `{raw}`"))?;
            }
            "--petnames" => parsed.petnames = Some(cursor.value("--petnames")?.to_string()),
            "--ephemeral" => parsed.ephemeral = true,
            other => return Err(format!("unknown option `{other}` for `fetch`")),
        }
    }
    Ok(parsed)
}

fn parse_petname(args: &[&str]) -> Result<PetnameArgs, String> {
    let mut cursor = Cursor::new(args);
    let verb = match cursor.next() {
        Some(verb) => verb,
        None => return Err("usage: nysiris petname <add|list|remove|resolve> ...".into()),
    };
    let mut file = None;
    let mut positionals = Vec::new();
    while let Some(arg) = cursor.next() {
        match arg {
            "--file" | "--petnames" => file = Some(cursor.value("--file")?.to_string()),
            other if other.starts_with("--") => {
                return Err(format!("unknown option `{other}` for `petname`"));
            }
            other => positionals.push(other.to_string()),
        }
    }
    let action = match (verb, positionals.as_slice()) {
        ("add", [name, address]) => PetnameAction::Add {
            name: name.clone(),
            address: address.clone(),
        },
        ("add", _) => return Err("usage: nysiris petname add <name> <nym-address>".into()),
        ("remove", [name]) | ("rm", [name]) => PetnameAction::Remove { name: name.clone() },
        ("remove", _) | ("rm", _) => return Err("usage: nysiris petname remove <name>".into()),
        ("resolve", [name]) => PetnameAction::Resolve { name: name.clone() },
        ("resolve", _) => return Err("usage: nysiris petname resolve <name>".into()),
        ("list", []) | ("ls", []) => PetnameAction::List,
        ("list", _) | ("ls", _) => return Err("usage: nysiris petname list".into()),
        (other, _) => {
            return Err(format!(
                "unknown petname action `{other}` (expected add, list, remove, resolve)"
            ))
        }
    };
    Ok(PetnameArgs { action, file })
}

fn parse_doctor(args: &[&str]) -> Result<DoctorArgs, String> {
    let mut parsed = DoctorArgs {
        common: CommonArgs::default(),
    };
    let mut cursor = Cursor::new(args);
    while let Some(arg) = cursor.next() {
        if parse_common(&mut cursor, &mut parsed.common, arg)? {
            continue;
        }
        return Err(format!("unknown option `{arg}` for `doctor`"));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri() -> String {
        nysiris_sdk::NymUri {
            identity: [1; 32],
            encryption: [2; 32],
            gateway: [3; 32],
        }
        .to_uri()
    }

    fn parse_str(input: &str) -> Result<Command, String> {
        parse(input.split_whitespace())
    }

    #[test]
    fn empty_args_and_help_show_usage() {
        assert_eq!(parse(Vec::<String>::new()).unwrap(), Command::Help);
        assert_eq!(parse_str("help").unwrap(), Command::Help);
        assert_eq!(parse_str("--help").unwrap(), Command::Help);
        assert_eq!(parse_str("version").unwrap(), Command::Version);
    }

    #[test]
    fn parses_host_echo_with_common_options() {
        let command =
            parse_str("host echo --data-dir /srv/ny --gateway gw-key --label shop --ephemeral")
                .unwrap();
        let Command::Host(host) = command else {
            panic!("expected host")
        };
        assert_eq!(host.service, ServiceKind::Echo);
        assert_eq!(host.common.data_dir.as_deref(), Some("/srv/ny"));
        assert_eq!(host.common.gateway.as_deref(), Some("gw-key"));
        assert_eq!(host.label.as_deref(), Some("shop"));
        assert!(host.ephemeral);
        assert!(host.web_root.is_none());
    }

    #[test]
    fn host_files_requires_and_parses_a_web_root() {
        assert!(parse_str("host files").is_err());
        let parsed =
            parse_str("host files --web-root ./public --index home.html --max-bytes 1200").unwrap();
        let Command::Host(host) = parsed else {
            panic!("expected host")
        };
        assert_eq!(host.service, ServiceKind::Files);
        assert_eq!(host.web_root.as_deref(), Some("./public"));
        assert_eq!(host.index.as_deref(), Some("home.html"));
        assert_eq!(host.max_bytes, Some(1200));
    }

    #[test]
    fn host_rejects_unknown_service_and_options() {
        assert!(parse_str("host blog").is_err());
        assert!(parse_str("host echo --nope").is_err());
        assert!(parse_str("host files --web-root").is_err());
        assert!(parse_str("host files --web-root ./x --max-bytes big").is_err());
    }

    #[test]
    fn parses_address_options() {
        let parsed = parse_str("address --data-dir ./d --out ./a.txt --ephemeral").unwrap();
        let Command::Address(address) = parsed else {
            panic!("expected address")
        };
        assert_eq!(address.common.data_dir.as_deref(), Some("./d"));
        assert_eq!(address.out.as_deref(), Some("./a.txt"));
        assert!(address.ephemeral);
    }

    #[test]
    fn fetch_defaults_and_overrides() {
        let parsed = parse_str("fetch shop").unwrap();
        let Command::Fetch(fetch) = parsed else {
            panic!("expected fetch")
        };
        assert_eq!(fetch.target, "shop");
        assert_eq!(fetch.method, "GET");
        assert_eq!(fetch.path, "/");
        assert_eq!(fetch.timeout_secs, 60);

        let parsed = parse_str(
            "fetch nym://x --method post --path /api --body hi --timeout 5 --petnames ./p.json",
        )
        .unwrap();
        let Command::Fetch(fetch) = parsed else {
            panic!("expected fetch")
        };
        assert_eq!(fetch.method, "POST");
        assert_eq!(fetch.path, "/api");
        assert_eq!(fetch.body.as_deref(), Some("hi"));
        assert_eq!(fetch.timeout_secs, 5);
        assert_eq!(fetch.petnames.as_deref(), Some("./p.json"));
    }

    #[test]
    fn fetch_requires_a_target() {
        assert!(parse_str("fetch").is_err());
        assert!(parse_str("fetch --path /").is_err());
    }

    #[test]
    fn parses_petname_actions() {
        let address = uri();
        let Command::Petname(add) = parse(["petname", "add", "shop", address.as_str()]).unwrap()
        else {
            panic!("expected petname")
        };
        match add.action {
            PetnameAction::Add {
                name,
                address: bound,
            } => {
                assert_eq!(name, "shop");
                assert_eq!(bound, address);
            }
            _ => panic!("expected add"),
        }

        let Command::Petname(list) = parse_str("petname list --file ./p.json").unwrap() else {
            panic!("expected petname")
        };
        assert_eq!(list.action, PetnameAction::List);
        assert_eq!(list.file.as_deref(), Some("./p.json"));

        assert!(matches!(
            parse_str("petname resolve shop").unwrap(),
            Command::Petname(PetnameArgs {
                action: PetnameAction::Resolve { .. },
                ..
            })
        ));
        assert!(parse_str("petname add shop").is_err());
        assert!(parse_str("petname frobnicate").is_err());
    }

    #[test]
    fn rejects_unknown_commands_and_options() {
        assert!(parse_str("frobnicate").is_err());
        assert!(parse_str("doctor --nope").is_err());
    }
}
