//! Embeds the zenoh-web server in an application that brings its own zenoh session, three
//! message encodings and its own video encoder:
//!
//! - `text_uppercase` (data): UTF-8 text, upper-cased; lower quality keeps a shorter prefix. The
//!   page decodes it with `registerEncoding("text_uppercase", (bytes) => new TextDecoder().decode(bytes))`.
//! - `rgb_swatch` (video): a 3-byte payload `r g b` becomes a 64x48 picture of that color (built
//!   as I420), sent on a video track; the page needs no decoder. `channel: "video-h264"` (the default) uses the
//!   bridge's encoder, `"video-av1"` the application's own AV1 encoder (rav1e, registered with
//!   `ServerBuilder::video_encoder`): how a hardware encoder (NVENC, a Jetson's) plugs in.
//! - `pcm_48k` (audio): the payload is 48 kHz mono signed 16-bit little-endian samples, which the
//!   bridge encodes to Opus on an audio track.
//!
//! ```sh
//! cargo run --example custom_codec -- --connect tcp/127.0.0.1:7447 --serve examples/web
//! ```

use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
use std::path::PathBuf;
use zenoh_web::{AudioPcm, Channel, DecodedFrame, EncodeOptions, EncodedVideo, EncodingOutput, EncodingSample, MessageEncoding, Server, VideoEncoder, VideoFormat, VideoImage, VideoTarget};

/// Upper-cases UTF-8 text. Quality q keeps the first `ceil(q × length)` characters.
struct TextUppercase;

impl MessageEncoding for TextUppercase {
    fn name(&self) -> &str {
        "text_uppercase"
    }

    fn output(&self) -> EncodingOutput {
        EncodingOutput::Data
    }

    fn decode(&self, sample: &EncodingSample<'_>, _channel: Channel) -> Result<DecodedFrame> {
        let text = std::str::from_utf8(sample.payload).context("text_uppercase needs UTF-8")?;
        Ok(DecodedFrame::data(text.to_uppercase()))
    }

    fn encode(&self, frame: &DecodedFrame, options: &EncodeOptions) -> Result<Vec<u8>> {
        let text = frame.downcast::<String>()?;
        let keep = (text.chars().count() as f64 * options.quality.clamp(0.0, 1.0)).ceil() as usize;
        Ok(text.chars().take(keep).collect::<String>().into_bytes())
    }

    fn estimated_bytes(&self, payload_bytes: usize, options: &EncodeOptions) -> f64 {
        payload_bytes as f64 * options.quality.clamp(0.05, 1.0)
    }
}

/// A 3-byte RGB payload as a solid 64x48 picture, handed to the bridge as I420 (BT.601), for any video channel.
struct RgbSwatch;

impl MessageEncoding for RgbSwatch {
    fn name(&self) -> &str {
        "rgb_swatch"
    }

    fn output(&self) -> EncodingOutput {
        EncodingOutput::Video
    }

    fn decode(&self, sample: &EncodingSample<'_>, _channel: Channel) -> Result<DecodedFrame> {
        let &[red, green, blue] = sample.payload else { anyhow::bail!("rgb_swatch needs 3 bytes, got {}", sample.payload.len()) };
        let (red, green, blue) = (red as f64, green as f64, blue as f64);
        let luma = 16.0 + 0.257 * red + 0.504 * green + 0.098 * blue;
        let u = 128.0 - 0.148 * red - 0.291 * green + 0.439 * blue;
        let v = 128.0 + 0.439 * red - 0.368 * green - 0.071 * blue;
        let (width, height) = (64usize, 48usize);
        let mut data = vec![luma.round() as u8; width * height];
        data.extend(std::iter::repeat_n(u.round() as u8, width * height / 4));
        data.extend(std::iter::repeat_n(v.round() as u8, width * height / 4));
        Ok(DecodedFrame::Video(VideoImage::i420(width as u32, height as u32, data)?))
    }
}

/// rav1e at its fastest preset, without lookahead, restarted when the target size changes (the application's own; the
/// bridge has one built in too).
#[derive(Default)]
struct Av1Encoder {
    context: Option<(rav1e::Context<u8>, (u32, u32))>,
}

impl VideoEncoder for Av1Encoder {
    fn format(&self) -> VideoFormat {
        VideoFormat::Av1
    }

    fn encode(&mut self, frame: &DecodedFrame, target: &VideoTarget) -> Result<Option<EncodedVideo>> {
        let DecodedFrame::Video(image) = frame else { bail!("the AV1 encoder takes pictures") };
        let (width, height) = (target.width, target.height);
        if self.context.as_ref().is_none_or(|(_, size)| *size != (width, height)) {
            let mut config = rav1e::config::EncoderConfig::with_speed_preset(10);
            (config.width, config.height, config.bitrate) = (width as usize, height as usize, target.bitrate_bps as i32);
            (config.low_latency, config.max_key_frame_interval, config.speed_settings.rdo_lookahead_frames) = (true, 90, 1);
            self.context = Some((rav1e::Config::new().with_encoder_config(config).with_threads(1).new_context()?, (width, height)));
        }
        let (context, _) = self.context.as_mut().expect("created above");
        let picture = image.to_i420(width, height)?;
        let (luma, chroma) = picture.data().split_at((width * height) as usize);
        let (u, v) = chroma.split_at(chroma.len() / 2);
        let mut input = context.new_frame();
        for (plane, (data, stride)) in input.planes.iter_mut().zip([(luma, width), (u, width / 2), (v, width / 2)]) {
            plane.copy_from_raw_u8(data, stride as usize, 1);
        }
        let keyframe = target.keyframe.then(|| rav1e::prelude::FrameParameters { frame_type_override: rav1e::prelude::FrameTypeOverride::Key, ..Default::default() });
        context.send_frame((input, keyframe))?;
        loop {
            match context.receive_packet() {
                Ok(packet) => return Ok(Some(EncodedVideo { data: packet.data, width, height, keyframe: packet.frame_type == rav1e::prelude::FrameType::KEY })),
                Err(rav1e::EncoderStatus::Encoded) => continue,
                Err(rav1e::EncoderStatus::NeedMoreData) => return Ok(None),
                Err(error) => bail!("rav1e: {error}"),
            }
        }
    }
}

/// 48 kHz mono s16le samples as PCM for the bridge's Opus encoder.
struct Pcm48k;

impl MessageEncoding for Pcm48k {
    fn name(&self) -> &str {
        "pcm_48k"
    }

    fn output(&self) -> EncodingOutput {
        EncodingOutput::Audio
    }

    fn decode(&self, sample: &EncodingSample<'_>, _channel: Channel) -> Result<DecodedFrame> {
        let samples = sample.payload.as_chunks::<2>().0.iter().map(|&bytes| i16::from_le_bytes(bytes)).collect();
        Ok(DecodedFrame::Audio(AudioPcm::new(48_000, 1, samples)?))
    }
}

#[derive(Parser)]
struct Cli {
    /// HTTP port (0 = any free port).
    #[arg(long, default_value_t = zenoh_web::DEFAULT_PORT)]
    port: u16,
    /// zenoh config file (json5) for the application's session.
    #[arg(long)]
    zenoh_config: Option<PathBuf>,
    /// zenoh endpoint to connect to (repeatable).
    #[arg(long)]
    connect: Vec<String>,
    /// Directory to serve over HTTP.
    #[arg(long)]
    serve: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,zenoh=warn,zenoh_web=info,rtc=warn,webrtc=warn")).init();
    let cli = Cli::parse();

    // the host application's own zenoh session, shared with zenoh-web
    let mut config = match &cli.zenoh_config {
        Some(path) => zenoh_web::zenoh::Config::from_file(path).map_err(|error| anyhow::anyhow!("{error}"))?,
        None => zenoh_web::zenoh::Config::default(),
    };
    if !cli.connect.is_empty() {
        config.insert_json5("connect/endpoints", &serde_json::to_string(&cli.connect)?).map_err(|error| anyhow::anyhow!("{error}"))?;
    }
    let session = zenoh_web::zenoh::open(config).await.map_err(|error| anyhow::anyhow!("{error}"))?;

    // channel video-av1 through this encoder instead of the built-in one, as a hardware encoder would plug in
    let mut builder = Server::builder().session(session.clone()).encoding(TextUppercase).encoding(RgbSwatch).encoding(Pcm48k).video_encoder(|| Box::new(Av1Encoder::default()));
    if let Some(dir) = cli.serve {
        builder = builder.serve_dir(dir);
    }
    let running = builder.build().await?.bind(("0.0.0.0", cli.port)).await?;
    ensure!(running.local_addr().port() != 0, "bound to port 0");

    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
    // deadmen fire and browsers disconnect; the session is ours to close
    running.shutdown().await?;
    session.close().await.map_err(|error| anyhow::anyhow!("{error}"))?;
    Ok(())
}
