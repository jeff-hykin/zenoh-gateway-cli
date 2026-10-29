//! A fake robot for tools/link_lab.js: a zenoh peer publishing what a robot sends a page, at rates and sizes changed
//! live on stdin.
//!
//! - `lab/tf`: `bytes` at `hz` (f64 send time, unix ms + u32 counter + zeros), congestion control Block (reliable)
//! - `lab/video`: a dimos `sensor_msgs.Image` (rgb8, `width` x `height`) at `hz`: moving shapes plus noise of strength
//!   `complexity` (0..1, how hard it is to encode), the send time stamped into its bottom 16 rows as 16 blocks (unix ms
//!   mod 65536, most significant bit left, white = 1)
//! - `lab/global_map`: `bytes` at `hz` (send time + counter + filler), congestion control Drop
//! - `lab/cmd_vel` (from the page): printed as `CMDVEL <unix ms received> <payload>`
//!
//! stdin: `SET <tf|video|global_map> <hz|bytes|width|height|complexity> <number>`; a line it can't apply is printed back
//! as `ERROR <line>`. Every stream starts off (hz 0): the page sends its own settings when it loads. Publishers only put
//! while matched.

mod common;

use common::{peer_config, print_line, report, stamp_image, stamped_payload, unix_ms};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncBufReadExt;
use zenoh::qos::CongestionControl;

#[derive(Clone, Default)]
struct Settings {
    hz: f64,
    bytes: usize,
    width: usize,
    height: usize,
    complexity: f64,
}

type Shared = Arc<Mutex<Settings>>;

/// The dimos LCM `sensor_msgs.Image` fingerprint (from zenoh-dimos-codecs' image_rgb8 fixture).
const IMAGE_FINGERPRINT: [u8; 8] = [0x53, 0x5c, 0xfa, 0xce, 0x1f, 0x4f, 0x57, 0x17];

fn lcm_string(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(&(text.len() as i32 + 1).to_be_bytes());
    out.extend_from_slice(text.as_bytes());
    out.push(0);
}

/// A dimos LCM Image message of `pixels` (rgb8, `width` x `height`).
fn lcm_image(width: usize, height: usize, pixels: &[u8]) -> Vec<u8> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("the clock is after 1970");
    let mut out = Vec::with_capacity(pixels.len() + 96);
    out.extend_from_slice(&IMAGE_FINGERPRINT);
    out.extend_from_slice(&(pixels.len() as i32).to_be_bytes());
    out.extend_from_slice(&(now.as_secs() as i64).to_be_bytes());
    out.extend_from_slice(&(now.subsec_nanos() as i32).to_be_bytes());
    lcm_string(&mut out, "camera_color_optical_frame");
    out.extend_from_slice(&(height as i32).to_be_bytes());
    out.extend_from_slice(&(width as i32).to_be_bytes());
    lcm_string(&mut out, "rgb8");
    out.push(0);
    out.extend_from_slice(&((width * 3) as i32).to_be_bytes());
    out.extend_from_slice(pixels);
    out
}

/// Frame `counter` of the test scene: a drifting gradient, two moving squares, noise of strength `complexity`, and the
/// send-time stamp.
fn scene(width: usize, height: usize, counter: u32, complexity: f64, seed: &mut u64) -> Vec<u8> {
    let mut pixels = vec![0u8; width * height * 3];
    let t = counter as usize;
    let noise = (complexity.clamp(0.0, 1.0) * 255.0) as u32;
    let square = height / 4;
    let squares = [((t * 7) % width, (t * 3) % height), ((width + width / 2 - (t * 5) % width) % width, (height / 2 + t * 2) % height)];
    for y in 0..height {
        for x in 0..width {
            let at = (y * width + x) * 3;
            let mut rgb = [((x + t * 2) * 255 / width) as u32 % 256, ((y + t) * 255 / height) as u32 % 256, 128];
            if squares.iter().any(|(sx, sy)| x.wrapping_sub(*sx) % width < square && y.wrapping_sub(*sy) % height < square) {
                rgb = [240, 240, 40];
            }
            if noise > 0 {
                // xorshift64
                *seed ^= *seed << 13;
                *seed ^= *seed >> 7;
                *seed ^= *seed << 17;
                let jitter = (*seed % (noise as u64 + 1)) as u32;
                rgb = rgb.map(|value| (value + jitter) % 256);
            }
            pixels[at..at + 3].copy_from_slice(&rgb.map(|value| value as u8));
        }
    }
    stamp_image(&mut pixels, width);
    pixels
}

/// [stamped_payload] with a filler that isn't zeros, so nothing on the path can compress the load away.
fn stamped(bytes: usize, counter: u32) -> Vec<u8> {
    let mut payload = stamped_payload(bytes, counter);
    for (i, byte) in payload[12..].iter_mut().enumerate() {
        *byte = (i as u32).wrapping_mul(2654435761).wrapping_add(counter) as u8;
    }
    payload
}

/// Puts `make(settings, counter)` on `key` at the settings' live rate while the key has a matching subscriber.
async fn publish(session: &zenoh::Session, key: &str, congestion: CongestionControl, settings: Shared, mut make: impl FnMut(&Settings, u32) -> Vec<u8> + Send + 'static) -> anyhow::Result<()> {
    let publisher = session.declare_publisher(key.to_owned()).congestion_control(congestion).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    tokio::spawn(async move {
        let mut counter: u32 = 0;
        let mut due = Instant::now();
        loop {
            let current = settings.lock().unwrap().clone();
            if current.hz <= 0.0 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                due = Instant::now();
                continue;
            }
            // a running schedule, skipping ticks that are already past rather than bursting to catch up
            due += Duration::from_secs_f64(1.0 / current.hz);
            let now = Instant::now();
            if due > now {
                tokio::time::sleep(due - now).await;
            } else {
                due = now;
            }
            if publisher.matching_status().await.is_ok_and(|status| status.matching()) {
                let payload = make(&current, counter);
                report(publisher.key_expr().as_str(), publisher.put(payload).await);
                counter = counter.wrapping_add(1);
            }
        }
    });
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listen = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: lab_peer <listen endpoint, e.g. tcp/127.0.0.1:17447>"))?;
    let session = zenoh::open(peer_config(&listen)?).await.map_err(|e| anyhow::anyhow!("{e}"))?;

    let (tf, video, global_map): (Shared, Shared, Shared) = Default::default();

    publish(&session, "lab/tf", CongestionControl::Block, tf.clone(), |settings, counter| stamped(settings.bytes, counter)).await?;
    publish(&session, "lab/global_map", CongestionControl::Drop, global_map.clone(), |settings, counter| stamped(settings.bytes, counter)).await?;
    let mut seed = 0x9e3779b97f4a7c15u64;
    publish(&session, "lab/video", CongestionControl::Drop, video.clone(), move |settings, counter| {
        // the stamp needs 16 columns and 16 rows
        let (width, height) = (settings.width.max(16), settings.height.max(16));
        lcm_image(width, height, &scene(width, height, counter, settings.complexity, &mut seed))
    })
    .await?;

    let _cmd_vel = session
        .declare_subscriber("lab/cmd_vel")
        .callback(|sample| print_line(&format!("CMDVEL {} {}", unix_ms(), String::from_utf8_lossy(&sample.payload().to_bytes()))))
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    print_line("READY");
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    // stdin closing (Ok(None)) means the lab is gone
    while let Some(line) = lines.next_line().await? {
        let parts: Vec<&str> = line.split_whitespace().collect();
        let ["SET", stream, field, value] = parts[..] else {
            print_line(&format!("ERROR {line}"));
            continue;
        };
        let (Some(settings), Ok(value)) = (
            match stream {
                "tf" => Some(&tf),
                "video" => Some(&video),
                "global_map" => Some(&global_map),
                _ => None,
            },
            value.parse::<f64>(),
        ) else {
            print_line(&format!("ERROR {line}"));
            continue;
        };
        let mut settings = settings.lock().unwrap();
        match field {
            "hz" => settings.hz = value,
            "bytes" => settings.bytes = value as usize,
            "width" => settings.width = value as usize,
            "height" => settings.height = value as usize,
            "complexity" => settings.complexity = value,
            _ => print_line(&format!("ERROR {line}")),
        }
    }
    Ok(())
}
