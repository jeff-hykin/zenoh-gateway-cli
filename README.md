# zenoh-web-cli

The `zenoh-web` command: a [zenoh-web](https://github.com/jeff-hykin/zenoh-web) server with the ROS 2
/ dimos codecs of [zenoh-dimos-codecs](https://github.com/jeff-hykin/zenoh-dimos-codecs). View and
drive a zenoh system from a browser over WebRTC: camera images as H.264 video, lossless depth,
quantized point clouds, raw bytes for everything else, and a per-browser bandwidth allocator. The
client API, the allocator and the wire protocol are documented in zenoh-web's README and SPEC.md.

![the example page: topic list, H.264 video, point cloud, depth, a raw stream and live allocation stats](test/artifacts/example.png)

## Install

Prebuilt binaries (Linux x86_64/aarch64 with glibc ≥ 2.35, macOS Apple Silicon/Intel; no Windows):

```sh
curl -fsSL https://raw.githubusercontent.com/jeff-hykin/zenoh-web-cli/main/install.sh | sh
```

It picks the [release](https://github.com/jeff-hykin/zenoh-web-cli/releases) tarball for your OS/CPU,
checks it against `SHA256SUMS`, and installs `zenoh-web` into `~/.local/bin`. Env overrides:
`ZENOH_WEB_VERSION=v0.3.0`, `ZENOH_WEB_INSTALL_DIR=/somewhere/bin`. (No release is published here
yet; the last one, v0.1.0, is at [jeff-hykin/zenoh-web](https://github.com/jeff-hykin/zenoh-web/releases).)

With nix (builds from source; aarch64-darwin, aarch64-linux, x86_64-linux):

```sh
nix profile install github:jeff-hykin/zenoh-web-cli   # puts zenoh-web on your PATH
nix run github:jeff-hykin/zenoh-web-cli -- --help     # or run it without installing
```

## Quick start

```sh
git clone https://github.com/jeff-hykin/zenoh-web-cli && cd zenoh-web-cli
cargo run --release -- --serve examples/web --connect tcp/127.0.0.1:7447   # your zenoh router/peer's endpoint
# open http://localhost:7448/
```

No robot handy? Start the test peer first; it publishes zenoh-dimos-codecs' fixtures (a 320×240
image, a 20000-point cloud and a 16-bit depth image, in the dimos message format) while someone
subscribes (`FIXTURES` = that repository's `test/fixtures`):

```sh
cargo run --release --example test_peer -- --listen tcp/127.0.0.1:7447 \
    --publish demo/camera/sensor_msgs.Image=$FIXTURES/dimos/image_rgb8.bin@10 \
    --publish demo/lidar/sensor_msgs.PointCloud2=$FIXTURES/dimos/pointcloud_xyzi.bin@10 \
    --publish demo/depth/sensor_msgs.Image=$FIXTURES/dimos/depth_16UC1.bin@10
```

Then on the page type a key (e.g. `demo/camera/sensor_msgs.Image`; the codec select guesses
`dimos-image`) and press Add. A recent stable Rust (edition 2024), or `nix develop` for a shell with
Rust, deno, zig and cargo-zigbuild.

The example page (`examples/web/`, plain JS, no build step) imports zenoh-web's client and the codecs'
decoders from esm.sh at pinned commits, so the browser needs internet. Query parameters:
`?bridge=<url>` (default: the page's origin), `?client=<module url>` and `?codecs=<module url>` (e.g.
`/client/zenoh_web.js` from `deno task build`, which bundles both, to work offline).

## Flags

| flag | default | |
|---|---|---|
| `--port <n>` | 7448 | HTTP port: `POST /offer` signaling and static files |
| `--zenoh-config <file>` | zenoh defaults (peer, multicast scouting) | zenoh json5 config, including `access_control` |
| `--connect <endpoint>` | | zenoh endpoint, e.g. `tcp/192.168.1.2:7447`; repeatable |
| `--serve <dir>` | | serve a directory (`/` → `index.html`), live-editable on disk |
| `--max-bandwidth-bytes-per-sec <n>` | none | cap every browser's budget below its estimate (known-slow link, tests) |
| `--bandwidth-target-fraction <f>` | 0.75 | share of the estimate the allocator hands out; the rest is headroom that keeps queues short |

Logging: `RUST_LOG=info,zenoh=warn`. Access control is zenoh's own: an `access_control` section in
`--zenoh-config` applies to the browsers' traffic like to any other (denied puts and subscriptions
are dropped silently), e.g. so no browser can drive the robot:

```json5
{
    mode: "peer",
    connect: { endpoints: ["tcp/192.168.1.2:7447"] },
    access_control: {
        enabled: true,
        default_permission: "allow",
        rules: [
            { id: "no-browser-cmd-vel", messages: ["put"], flows: ["egress", "ingress"], permission: "deny", key_exprs: ["**/cmd_vel/**"] },
        ],
        subjects: [{ id: "anyone" }],
        policies: [{ rules: ["no-browser-cmd-vel"], subjects: ["anyone"] }],
    },
}
```

## Building with nix

```sh
nix build .#zenoh-web                  # native (default package); result/bin/zenoh-web
nix build .#zenoh-web-aarch64-linux    # on an Apple Silicon Mac: aarch64 Linux binary (Jetson, Pi 5)
nix build .#zenoh-web-x86_64-linux     # on an Apple Silicon Mac: x86_64 Linux binary
nix build .#zenoh-web-x86_64-darwin    # on an Apple Silicon Mac: Intel macOS binary
nix develop                            # Rust (+ aarch64-linux target), clippy, deno, zig, cargo-zigbuild
```

- The Linux cross builds use cargo-zigbuild with zig as the C/C++ toolchain (openh264, zstd) against glibc
  2.35 (Ubuntu 22.04, Jetson L4T 36, Pi OS bookworm). The binary needs only `libc.so.6`, `libm.so.6`
  and the loader (C++ runtime linked statically).
- The macOS binary links `/usr/lib/libiconv.2.dylib` (rewritten from nix's copy), so it runs on Macs without nix.
  The Intel one is built by the same clang/SDK with `--target x86_64-apple-darwin` (macOS ≥ 14).
- Cargo dependencies come from `Cargo.lock` (`importCargoLock`); the zenoh-web and zenoh-dimos-codecs
  git dependencies need their `outputHashes` in `flake.nix` updated whenever their pinned commits change.

## Releases

All four release binaries are built on an Apple Silicon Mac, with no remote builders:

```sh
nix build .#release --builders ''   # result/<target-triple>/zenoh-web for
                                    # aarch64-apple-darwin, x86_64-apple-darwin,
                                    # aarch64-unknown-linux-gnu, x86_64-unknown-linux-gnu
gh release create v<version> result/dist/*  # the tarballs + SHA256SUMS
```

`result/dist/` holds `zenoh-web-<version>-<target-triple>.tar.gz` (binary + README.md) and
`SHA256SUMS`, made by GNU tar inside the build (no macOS extended attributes, fixed owner and
mtime); `install.sh` reads those names.

## Tests

```sh
cargo test && cargo clippy --all-targets   # the command and the test programs
deno task e2e                              # every end-to-end suite (several minutes)
```

The suites build zenoh-web and zenoh-dimos-codecs at the commits `Cargo.lock` pins (their checkouts
come from `cargo metadata`: the browser client is bundled from them and the fixtures read from the
codecs'). To test local changes, point cargo at your clones, e.g.
`cargo update` after adding to `.cargo/config.toml`:

```toml
[patch."https://github.com/jeff-hykin/zenoh-web"]
zenoh-web = { path = "../zenoh-web/bridge" }
[patch."https://github.com/jeff-hykin/zenoh-dimos-codecs"]
zenoh-dimos-codecs = { path = "../zenoh-dimos-codecs" }
```

Each suite starts a real zenoh test peer (`examples/test_peer.rs`), the server, and its own headless
Chrome (never the one on port 9222):

- `test/e2e.js`: pipe, delivery modes, option rejection, clock sync, deadman, zenoh access control,
  chunked messages, topic listing.
- `test/codecs.js`: every fixture through each codec: depth values exact at full and half resolution,
  point clouds within the documented quantization bound (intensity exact), video by its quadrant
  colors within ±10 of the pattern (H.264 is lossy), plus unknown-codec rejections and encodes shared
  across frontends.
- `test/custom_codec.js`: `examples/custom_codec.rs` (zenoh-web with its own zenoh session and two
  codecs of its own): a data codec's text exact through a `registerCodec` decoder (full and half
  quality), a video codec's I420 frames by their color within ±20, unknown names rejected.
- `test/allocation.js`: streams shrinking by `bandwidthPriority` (equal, unequal, weight 0 last) and the
  quality/Hz tradeoff under `--max-bandwidth-bytes-per-sec`.
- `test/abandoned.js`: a viewer whose browser freezes without closing anything: the bridge drops it and
  goes idle.
- `test/latency.js`: a strict-priority stream's p99 under bulk load through a userspace UDP shaper.
- `test/throughput.js` (`deno task e2e:throughput`): one data channel's delivered rate through the shaper
  with delay jitter (`test/shaped_link.js`): at least 2 Mb/s on a ~50 ms ± 20 ms link, and reported
  for a Wi-Fi-like link (RTT 10-430 ms) and a spiky, lossy one.
- `test/video_latency.js` (`deno task e2e:video-latency`): publish -> arrival -> shown for H.264,
  frames identified by a send-time stamp the test peer draws into the pixels;
  H.264 must be shown within 10 ms of arriving (zero playout delay). `--profile jitter50|wifi` shapes it.
- `test/example.js` (`deno task e2e:example`): the example page served by `--serve examples/web`, driven
  through its form; checks decoded video frames, drawn points and depth, the raw rate, a control
  re-subscribing, no console errors, and writes `test/artifacts/example.png`. **Needs internet**
  (esm.sh, at the commits `examples/web/app.js` pins).
