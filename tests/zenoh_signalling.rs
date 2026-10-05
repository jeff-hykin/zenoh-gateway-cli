//! The `zenoh-web` command behind a relay: `--zenoh-signalling robot --no-http`, its zenoh dialling out to a router,
//! reached the way zenoh-web-relay reaches it (`Client::connect_zenoh` over that router).

use std::process::{Child, Command};
use std::time::Duration;
use tokio::time::timeout;
use zenoh_web::client::{Client, ClientOptions, Delivery, Message, PublisherOptions, SubscribeOptions};
use zenoh_web::zenoh;

struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cli_answers_signalling_over_zenoh_with_no_http() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut config = zenoh::Config::default();
    for (key, value) in [("mode", "\"router\"".to_owned()), ("scouting/multicast/enabled", "false".to_owned()), ("listen/endpoints", format!("[\"tcp/127.0.0.1:{port}\"]"))] {
        config.insert_json5(key, &value).unwrap();
    }
    let router = zenoh::open(config).await.unwrap();
    let dir = std::env::temp_dir().join(format!("zenoh-web-cli-signalling-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("tokens.json5"), r#"{ tokens: { "relay-secret": "write" } }"#).unwrap();
    std::fs::write(dir.join("zenoh.json5"), r#"{ mode: "peer", scouting: { multicast: { enabled: false } }, listen: { endpoints: [] } }"#).unwrap();
    let _cli = KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_zenoh-web"))
            .args(["--zenoh-config", dir.join("zenoh.json5").to_str().unwrap(), "--connect", &format!("tcp/127.0.0.1:{port}")])
            .args(["--zenoh-signalling", "robot", "--no-http", "--video-encoder", "software", "--auth-file", dir.join("tokens.json5").to_str().unwrap()])
            .spawn()
            .unwrap(),
    );
    let options = |token: &str| ClientOptions { token: Some(token.into()), ..Default::default() };
    // the command starts and dials in meanwhile
    let mut refused = String::new();
    for _ in 0..100 {
        refused = Client::connect_zenoh(&router, "robot", options("nope")).await.err().unwrap().to_string();
        if !refused.contains("no zenoh-web server answered") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(refused.contains("refused the token: unknown token"), "{refused}");
    let client = Client::connect_zenoh(&router, "robot", options("relay-secret")).await.unwrap();
    assert!(client.encodings().iter().any(|encoding| encoding.output == "video"), "the dimos encodings are registered: {:?}", client.encodings());

    let mut state = client.subscribe("robot/state", SubscribeOptions::default()).await.unwrap();
    let putter = {
        let router = router.clone();
        tokio::spawn(async move {
            loop {
                router.put("robot/state", "ok").await.unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
    };
    let Message::Data(message) = timeout(Duration::from_secs(10), state.recv()).await.unwrap().unwrap() else { panic!("not data") };
    assert_eq!(message.bytes, b"ok");

    let commands = router.declare_subscriber("robot/cmd").await.unwrap();
    let publisher = client.publish("robot/cmd", PublisherOptions { delivery: Some(Delivery::Reliable), ..Default::default() }).await.unwrap();
    publisher.put(b"go").await.unwrap();
    let sample = timeout(Duration::from_secs(5), commands.recv_async()).await.unwrap().unwrap();
    assert_eq!(sample.payload().to_bytes().as_ref(), b"go");
    putter.abort();
    client.close().await;
}
