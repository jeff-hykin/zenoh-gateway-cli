//! What test_peer and lab_peer share: their zenoh setup, the send-time stamps the pages read back, and stdout lines.

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn unix_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("the clock is after 1970").as_secs_f64() * 1000.0
}

/// An isolated zenoh peer listening on `listen` (no multicast scouting, so a run never meets other zenoh systems).
pub fn peer_config(listen: &str) -> anyhow::Result<zenoh::Config> {
    let mut config = zenoh::Config::default();
    for (key, value) in [("mode", r#""peer""#.to_owned()), ("listen/endpoints", serde_json::to_string(&[listen])?), ("scouting/multicast/enabled", "false".to_owned())] {
        config.insert_json5(key, &value).map_err(|e| anyhow::anyhow!("{key}: {e}"))?;
    }
    Ok(config)
}

/// A payload of `bytes` (at least 12) starting with the send time (f64 LE unix ms) and `counter` (u32 LE), zeros after.
pub fn stamped_payload(bytes: usize, counter: u32) -> Vec<u8> {
    let mut payload = vec![0u8; bytes.max(12)];
    payload[0..8].copy_from_slice(&unix_ms().to_le_bytes());
    payload[8..12].copy_from_slice(&counter.to_le_bytes());
    payload
}

/// Paints the send time into the bottom 16 rows of the `width`-wide RGB image ending `image`: 16 equal blocks, unix ms
/// mod 65536, most significant bit left, white = 1 (what test/video_latency.js and tools/link_lab.html read back).
pub fn stamp_image(image: &mut [u8], width: usize) {
    let stamp = unix_ms() as u64 as u16;
    let rows = 16.min(image.len() / (width * 3));
    let start = image.len() - width * rows * 3;
    for row in 0..rows {
        for x in 0..width {
            let bit = 15 - (x * 16 / width);
            let value = if (stamp >> bit) & 1 == 1 { 255 } else { 0 };
            let at = start + (row * width + x) * 3;
            image[at..at + 3].fill(value);
        }
    }
}

/// A line for the test or lab reading stdout; flushed, since that reader waits on it.
pub fn print_line(line: &str) {
    let mut stdout = std::io::stdout().lock();
    if let Err(error) = writeln!(stdout, "{line}").and_then(|()| stdout.flush()) {
        eprintln!("stdout: {error} (dropped: {line})");
    }
}

/// Logs a failed put or reply instead of dropping it silently.
pub fn report<T>(what: &str, result: zenoh::Result<T>) {
    if let Err(error) = result {
        eprintln!("{what}: {error}");
    }
}
