//! The `zenoh-web` command: [zenoh_web::Server] with the [zenoh_dimos_codecs] message encodings registered.

use clap::Parser;
use log::{info, warn};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use zenoh_web::{Grant, IceServer};

#[derive(Parser, Debug)]
#[command(name = "zenoh-web", version, about = "A gateway from zenoh to browsers over WebRTC: data channels, video and audio tracks")]
struct Cli {
    /// HTTP port for signaling (POST /offer) and static files.
    #[arg(long, default_value_t = zenoh_web::DEFAULT_PORT)]
    port: u16,
    /// zenoh config file (json5).
    #[arg(long)]
    zenoh_config: Option<PathBuf>,
    /// zenoh endpoint to connect to, e.g. tcp/192.168.1.2:7447 (repeatable).
    #[arg(long)]
    connect: Vec<String>,
    /// Serve this directory over HTTP (so the UI is live-editable on disk).
    #[arg(long)]
    serve: Option<PathBuf>,
    /// Cap each frontend's bandwidth budget (bytes/s) below the estimate, e.g. for a known-slow
    /// link or to test allocation on localhost.
    #[arg(long)]
    max_bandwidth_bytes_per_sec: Option<f64>,
    /// Fraction of the estimated bandwidth the allocator hands out; the rest keeps the path's
    /// queues short for strict-priority streams.
    #[arg(long, default_value_t = 0.75)]
    bandwidth_target_fraction: f64,
    /// Require a token: a json5 file mapping tokens to grants (see README "Auth"); re-read when it changes,
    /// and a token removed or changed there is revoked (its connections close).
    #[arg(long)]
    auth_file: Option<PathBuf>,
    /// STUN/TURN server for both ends, e.g. stun:stun.l.google.com:19302 or turn:user:pass@relay.example:3478 (repeatable).
    #[arg(long)]
    ice_server: Vec<String>,
    /// coturn's static-auth-secret: TURN servers without user:pass get credentials minted per connection (valid 24 h).
    #[arg(long)]
    turn_secret: Option<String>,
    /// Command that mints STUN/TURN servers for each end of each connection, added after --ice-server: run with sh -c,
    /// with ZENOH_WEB_ICE_SIDE=browser|gateway and ZENOH_WEB_ICE_TOKEN (the connection's token, if any); it prints
    /// {"iceServers": [...]} or [...] (RTCIceServer objects). On failure, or after 5 s, that end gets only --ice-server.
    #[arg(long, conflicts_with = "cloudflare_turn_key_id")]
    ice_servers_command: Option<String>,
    /// Cloudflare TURN key id: mint TURN credentials through Cloudflare's API (needs CLOUDFLARE_TURN_API_TOKEN).
    #[arg(long, requires = "cloudflare_turn_api_token")]
    cloudflare_turn_key_id: Option<String>,
    /// The Cloudflare TURN key's API token (an environment variable, so it stays out of `ps`).
    #[arg(long, env = "CLOUDFLARE_TURN_API_TOKEN", hide_env_values = true, hide = true)]
    cloudflare_turn_api_token: Option<String>,
    /// How long Cloudflare TURN credentials last, in seconds; shared ones are minted again after half of it.
    #[arg(long, default_value_t = 24 * 3600)]
    cloudflare_turn_ttl: u64,
    /// Mint Cloudflare TURN credentials for every connection instead of sharing one set.
    #[arg(long)]
    cloudflare_turn_per_connection: bool,
    /// UDP port (50000) or range (50000-50100) for WebRTC, one port per browser connection.
    #[arg(long, alias = "udp-port")]
    udp_ports: Option<String>,
    /// Video encoder: auto (hardware if one works: VideoToolbox, or GStreamer's nvv4l2h264enc / nvh264enc / VAAPI;
    /// else software), software (openh264), videotoolbox or gstreamer.
    #[arg(long, default_value = "auto")]
    video_encoder: zenoh_dimos_codecs::encoders::Backend,
    /// Also answer WebRTC signalling over zenoh as <name> (queryables zenoh-web/<name>/offer and /ice), so a
    /// zenoh-web-relay this gateway's zenoh dials out to (--connect) can reach it with no inbound port.
    #[arg(long)]
    zenoh_signalling: Option<String>,
    /// Serve no HTTP (no --port listener): signalling only over zenoh (needs --zenoh-signalling).
    #[arg(long, requires = "zenoh_signalling")]
    no_http: bool,
}

/// `--auth-file`: `{ tokens: { "<token>": "read" | "write" | "lease" | <grant> }, leaseGroups: { "<group>": ["<key expr>"] } }`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct AuthFile {
    tokens: HashMap<String, Role>,
    lease_groups: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Role {
    Named(String),
    Grant(Grant),
}

/// read: subscribe, query and list everything; write: also publish; lease: also lease any group.
fn role_grant(role: &Role) -> anyhow::Result<Grant> {
    let all = || vec!["**".to_owned()];
    let read = Grant { subscribe: all(), query: all(), list_topics: all(), ..Default::default() };
    match role {
        Role::Grant(grant) => Ok(grant.clone()),
        Role::Named(name) => match name.as_str() {
            "read" => Ok(read),
            "write" => Ok(Grant { publish: all(), ..read }),
            "lease" => Ok(Grant { publish: all(), lease_groups: vec!["*".into()], ..read }),
            other => anyhow::bail!("unknown role {other:?} (read, write, lease, or a grant object)"),
        },
    }
}

/// token -> grant, and lease group -> keys
type Auth = (HashMap<String, Grant>, HashMap<String, Vec<String>>);

fn load_auth_file(path: &Path) -> anyhow::Result<Auth> {
    let file: AuthFile = json5::from_str(&std::fs::read_to_string(path)?).map_err(|error| anyhow::anyhow!("{}: {error}", path.display()))?;
    let tokens = file.tokens.iter().map(|(token, role)| Ok((token.clone(), role_grant(role)?))).collect::<anyhow::Result<_>>()?;
    Ok((tokens, file.lease_groups))
}

/// Polls the auth file; tokens removed or changed there are revoked.
async fn watch_auth_file(path: PathBuf, tokens: Arc<RwLock<HashMap<String, Grant>>>, server: zenoh_web::Server) {
    let modified = |path: &Path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok();
    let mut last = modified(&path);
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let now = modified(&path);
        if now == last {
            continue;
        }
        last = now;
        match load_auth_file(&path) {
            Ok((new_tokens, _)) => {
                let old = std::mem::replace(&mut *tokens.write().unwrap(), new_tokens.clone());
                for (token, grant) in old {
                    if new_tokens.get(&token) != Some(&grant) {
                        info!("auth file: token changed or removed, revoked {} connection(s)", server.revoke(&token));
                    }
                }
            }
            Err(error) => warn!("auth file not reloaded: {error:#}"),
        }
    }
}

/// `turn:user:pass@host:port` -> the URL without `user:pass@`, and the credentials.
fn ice_server(arg: &str) -> IceServer {
    let (scheme, rest) = arg.split_once(':').unwrap_or((arg, ""));
    match rest.rsplit_once('@') {
        Some((credentials, host)) => {
            let (username, credential) = credentials.split_once(':').unwrap_or((credentials, ""));
            IceServer { urls: vec![format!("{scheme}:{host}")], username: username.into(), credential: credential.into() }
        }
        None => IceServer { urls: vec![arg.to_owned()], ..Default::default() },
    }
}

/// `--ice-servers-command`: runs `command` for `request`, and reads `{"iceServers": [...]}` or `[...]` from its stdout.
async fn command_ice_servers(command: &str, request: zenoh_web::IceRequest) -> anyhow::Result<Vec<IceServer>> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Printed {
        Wrapped {
            #[serde(rename = "iceServers")]
            ice_servers: Vec<IceServer>,
        },
        Bare(Vec<IceServer>),
    }
    let side = match request.side {
        zenoh_web::IceSide::Browser => "browser",
        zenoh_web::IceSide::Gateway => "gateway",
    };
    let output = tokio::process::Command::new("sh")
        .args(["-c", command])
        .env("ZENOH_WEB_ICE_SIDE", side)
        .env("ZENOH_WEB_ICE_TOKEN", request.token.unwrap_or_default())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await?;
    anyhow::ensure!(output.status.success(), "--ice-servers-command exited with {}: {}", output.status, String::from_utf8_lossy(&output.stderr).trim());
    let printed: Printed = serde_json::from_slice(&output.stdout).map_err(|error| anyhow::anyhow!("--ice-servers-command printed no ICE servers: {error}"))?;
    Ok(match printed {
        Printed::Wrapped { ice_servers } | Printed::Bare(ice_servers) => ice_servers,
    })
}

/// Resolves on SIGINT or SIGTERM.
async fn terminated() {
    let mut terminate = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(terminate) => terminate,
        Err(error) => {
            log::warn!("no SIGTERM handler: {error}");
            let _ = tokio::signal::ctrl_c().await;
            info!("SIGINT");
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => info!("SIGINT"),
        _ = terminate.recv() => info!("SIGTERM"),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,zenoh=warn,zenoh_ext=warn,zenoh_web=info,rtc=warn,webrtc=warn")).init();
    let cli = Cli::parse();
    let mut builder = zenoh_web::Server::builder().bandwidth_target_fraction(cli.bandwidth_target_fraction);
    let video = zenoh_dimos_codecs::encoders::select(cli.video_encoder)?;
    info!("video encoder: {}", video.name);
    if let Some(factory) = video.factory {
        builder = builder.video_encoder(factory);
    }
    for codec in zenoh_dimos_codecs::all() {
        builder = builder.shared_encoding(codec);
    }
    if let Some(path) = &cli.zenoh_config {
        builder = builder.zenoh_config_file(path)?;
    }
    for endpoint in cli.connect {
        builder = builder.connect(endpoint);
    }
    if let Some(dir) = cli.serve {
        builder = builder.serve_dir(dir);
    }
    if let Some(cap) = cli.max_bandwidth_bytes_per_sec {
        builder = builder.max_bandwidth_bytes_per_sec(cap);
    }
    builder = builder.ice_servers(cli.ice_server.iter().map(|arg| ice_server(arg)));
    if let Some(secret) = cli.turn_secret {
        builder = builder.turn_secret(secret, Duration::from_secs(24 * 3600));
    }
    if let Some(command) = cli.ice_servers_command {
        let command = Arc::new(command);
        builder = builder.ice_servers_fn(move |request| {
            let command = command.clone();
            async move { command_ice_servers(&command, request).await }
        });
    }
    if let (Some(key_id), Some(api_token)) = (cli.cloudflare_turn_key_id, cli.cloudflare_turn_api_token) {
        info!("TURN credentials from Cloudflare (key {key_id}, ttl {} s{})", cli.cloudflare_turn_ttl, if cli.cloudflare_turn_per_connection { ", per connection" } else { "" });
        let turn = zenoh_web::CloudflareTurn::new(key_id, api_token).ttl(Duration::from_secs(cli.cloudflare_turn_ttl)).per_connection(cli.cloudflare_turn_per_connection);
        builder = builder.cloudflare_turn(turn);
    }
    if let Some(ports) = &cli.udp_ports {
        let (low, high) = ports.split_once('-').unwrap_or((ports, ports));
        builder = builder.udp_ports(low.trim().parse()?..=high.trim().parse()?);
    }
    if let Some(name) = &cli.zenoh_signalling {
        builder = builder.zenoh_signalling(name);
    }
    let tokens = Arc::new(RwLock::new(HashMap::new()));
    if let Some(path) = &cli.auth_file {
        let (initial, lease_groups) = load_auth_file(path)?;
        *tokens.write().unwrap() = initial;
        for (name, keys) in lease_groups {
            builder = builder.lease_group(name, keys);
        }
        let tokens = tokens.clone();
        builder = builder.authorize(move |token, _headers| {
            let token = token.ok_or("a token is required (connect(url, { token }))")?;
            tokens.read().unwrap().get(token).cloned().ok_or_else(|| "unknown token".to_owned())
        });
    }
    let server = builder.build().await?;
    if let Some(path) = cli.auth_file {
        tokio::spawn(watch_auth_file(path, tokens, server.clone()));
    }
    // every frontend's deadmen go out (reliably) before the zenoh session closes
    if cli.no_http {
        info!("no HTTP listener: signalling over zenoh only");
        terminated().await;
        return server.shutdown().await;
    }
    server.serve_with_shutdown(("0.0.0.0", cli.port), terminated()).await
}
