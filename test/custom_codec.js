#!/usr/bin/env -S deno run --allow-all
// Encodings from outside zenoh-gateway end-to-end: examples/custom_codec.rs embeds the server (library API,
// the application's own zenoh session) with a data encoding, a video encoding (on the bridge's H.264, and on
// video-av1 through the application's own AV1 encoder) and an audio encoding written in Rust; a real zenoh peer
// publishes, headless Chrome subscribes with `encoding: "<custom>"`.
// Usage: deno run --allow-all test/custom_codec.js
// ZENOH_GATEWAY_CUSTOM_CODEC_BIN=<path> runs another build of the same program (e.g. a downstream crate's).

import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { bridgeDir, buildAll, check, finish, launchBrowser, machineLoad, startBridge, startPeer } from "./harness.js"

const scratch = $.path(await Deno.makeTempDir({ prefix: "zenoh-gateway-custom-codec-" }))
console.log(`machine load at start: ${await machineLoad()}`)

const text = "hello from zenoh, ünïcode too"
const swatch = [230, 120, 20]
// 20 ms of a 400 Hz tone at 48 kHz (exactly 8 periods, so back-to-back messages join seamlessly)
const toneHz = 400
const tone = new Int16Array(960).map((_, index) => Math.round(Math.sin(2 * Math.PI * toneHz * index / 48000) * 8000))

try {
    const otherBinary = Deno.env.get("ZENOH_GATEWAY_CUSTOM_CODEC_BIN")
    const webRoot = await buildAll(scratch, otherBinary ? [] : ["custom_codec"])
    const binary = otherBinary ?? bridgeDir.join("target/release/examples/custom_codec").toString()
    scratch.join("text.txt").writeTextSync(text)
    scratch.join("swatch.rgb").writeSync(new Uint8Array(swatch))
    scratch.join("tone.pcm").writeSync(new Uint8Array(tone.buffer))
    const peer = await startPeer(["--publish", `demo/text=${scratch.join("text.txt")}@10`, "--publish", `demo/swatch=${scratch.join("swatch.rgb")}@10`, "--publish", `demo/tone=${scratch.join("tone.pcm")}@50`])
    $.logStep(`starting ${binary}`)
    const bridge = await startBridge(scratch, peer.zenohPort, webRoot, [], binary)
    await $.sleep(1000)
    const browser = await launchBrowser()
    const page = await browser.newPage(`${bridge.url}/test/blank.html`)

    const result = await page.evaluate(async (bridgeUrl) => {
        const { connect, registerEncoding } = await import("/client/zenoh_gateway.js")
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const out = {}
        const client = await connect(bridgeUrl)
        out.encodings = client.encodings

        // data encoding: the page supplies the decoder
        registerEncoding("text_uppercase", (bytes) => new TextDecoder().decode(bytes))
        const firstMessage = (options) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ error: "no message in 8 s" }), 8000)
            const subscription = client.subscribe("demo/text", options, (message) => {
                clearTimeout(timer)
                subscription.close()
                resolve({ decoded: message.decoded, bytes: message.bytes.length })
            })
            subscription.ready().catch((error) => resolve({ error: error.message }))
        })
        out.full = await firstMessage({ encoding: "text_uppercase" })
        out.reduced = await firstMessage({ encoding: "text_uppercase", encodeOptions: { quality: 0.5 } })
        try {
            registerEncoding("text_uppercase", () => "another")
            out.duplicateDecoder = null
        } catch (error) {
            out.duplicateDecoder = error.message
        }

        // video: no page code, frames arrive on the subscription's MediaStream
        window.watch = async (channel) => {
            const frames = []
            const video = client.subscribe("demo/swatch", { encoding: "rgb_swatch", channel }, (message) => frames.push(message.video))
            let seen
            try {
                await video.ready()
                const element = document.createElement("video")
                element.muted = true
                element.playsInline = true
                element.srcObject = video.mediaStream
                document.body.append(element)
                await element.play().catch(() => {})
                for (let index = 0; index < 4; index++) {
                    await Promise.race([new Promise((resolve) => element.requestVideoFrameCallback(resolve)), sleep(3000)])
                }
                const canvas = document.createElement("canvas")
                canvas.width = element.videoWidth
                canvas.height = element.videoHeight
                const context = canvas.getContext("2d", { willReadFrequently: true })
                context.drawImage(element, 0, 0)
                const { width, height } = canvas
                const pixels = width && height ? context.getImageData(0, 0, width, height).data : new Uint8ClampedArray()
                const sums = [0, 0, 0]
                let count = 0
                for (let offset = 0; offset < pixels.length; offset += 4) {
                    sums[0] += pixels[offset]
                    sums[1] += pixels[offset + 1]
                    sums[2] += pixels[offset + 2]
                    count++
                }
                await client.pollStats()
                const stats = [...(await client._peer.getStats()).values()]
                const inbound = stats.find((report) => report.type === "inbound-rtp" && report.kind === "video" && report.trackIdentifier === video.mediaStream.getVideoTracks()[0].id)
                const mimeType = stats.find((report) => report.id === inbound?.codecId)?.mimeType
                seen = { width, height, mean: sums.map((sum) => Math.round(sum / Math.max(1, count))), frames: frames.length, metadata: frames.at(-1) ?? null, decodeErrors: video.decodeErrors, encodingErrors: video.gatewayStats?.stats?.encodingErrors, lastEncodingError: video.gatewayStats?.stats?.lastEncodingError, mimeType, framesDecoded: inbound?.framesDecoded }
                element.remove()
            } catch (error) {
                seen = { error: error.message }
            }
            video.close()
            return seen
        }

        // audio encoding: PCM in, Opus on an audio track; the page hears a 400 Hz tone
        window.listen = async () => {
            let heard
            let audioMessages = 0
            const audio = client.subscribe("demo/tone", { encoding: "pcm_48k" }, () => audioMessages++)
            try {
                await audio.ready()
                const element = document.createElement("audio")
                element.srcObject = audio.mediaStream
                document.body.append(element)
                await element.play().catch(() => {})
                const context = new AudioContext()
                await context.resume()
                const analyser = context.createAnalyser()
                analyser.fftSize = 8192
                context.createMediaStreamSource(audio.mediaStream).connect(analyser)
                await sleep(3000)
                const spectrum = new Float32Array(analyser.frequencyBinCount)
                analyser.getFloatFrequencyData(spectrum)
                const peak = spectrum.indexOf(Math.max(...spectrum))
                const stats = [...(await client._peer.getStats()).values()]
                const inbound = stats.find((report) => report.type === "inbound-rtp" && report.kind === "audio")
                await client.pollStats()
                heard = {
                    peakHz: Math.round(peak * context.sampleRate / analyser.fftSize), peakDb: Math.round(spectrum[peak]),
                    messages: audioMessages, bytesReceived: inbound?.bytesReceived, totalAudioEnergy: inbound?.totalAudioEnergy,
                    mimeType: stats.find((report) => report.id === inbound?.codecId)?.mimeType, encodingErrors: audio.gatewayStats?.stats?.encodingErrors, lastEncodingError: audio.gatewayStats?.stats?.lastEncodingError,
                }
                context.close()
                element.remove()
            } catch (error) {
                heard = { error: error.message }
            }
            audio.close()
            return heard
        }

        // the bridge rejects an unknown name (listing its encodings) and reliable delivery of video
        const rejection = (key, options) => client.subscribe(key, options, () => {}).ready().then(() => null, (error) => error.message)
        out.unknownError = await rejection("demo/text", { encoding: "text-lowercase" })
        out.reliableVideoError = await rejection("demo/swatch", { encoding: "rgb_swatch", delivery: "reliable" })
        const raw = client._peer.createDataChannel(JSON.stringify({ type: "sub", key: "demo/text", id: 999999, opts: { encoding: "text-lowercase" } }))
        out.rawClosed = await new Promise((resolve) => {
            raw.onclose = () => resolve(true)
            setTimeout(() => resolve(false), 5000)
        })
        window.client = client
        return out
    }, { args: [bridge.url] })
    // one evaluate each: astral gives every evaluate a time limit
    result.video = await page.evaluate(() => window.watch("video-h264"))
    result.av1 = await page.evaluate(() => window.watch("video-av1"))
    result.audio = await page.evaluate(() => window.listen())
    await page.evaluate(() => window.client.close())
    console.log(JSON.stringify(result))

    check(JSON.stringify(result.encodings) === JSON.stringify([{ name: "pcm_48k", output: "audio" }, { name: "rgb_swatch", output: "video" }, { name: "text_uppercase", output: "data" }]),
        `client sees the server's encodings (${JSON.stringify(result.encodings)})`)
    const upper = text.toUpperCase()
    check(result.full.decoded === upper, `data encoding: registered decoder got "${result.full.decoded}" (expected "${upper}")`)
    const half = [...upper].slice(0, Math.ceil([...upper].length * 0.5)).join("")
    check(result.reduced.decoded === half, `data encoding at encodeOptions.quality 0.5: "${result.reduced.decoded}" (expected "${half}")`)
    check(result.duplicateDecoder?.includes("already registered"), `client: a second decoder for the same encoding throws (${result.duplicateDecoder})`)
    for (const [video, mimeType, label] of [[result.video, "video/H264", "the bridge's H.264"], [result.av1, "video/AV1", "the application's own AV1 encoder (ServerBuilder::video_encoder)"]]) {
        const worst = video.error ? Infinity : Math.max(...video.mean.map((value, channel) => Math.abs(value - swatch[channel])))
        check(!video.error && video.width === 64 && video.height === 48 && worst <= 20 && video.frames > 0 && video.decodeErrors === 0 && video.encodingErrors === 0 && video.mimeType === mimeType,
            `video through ${label}: ${video.mimeType}, ${video.width}x${video.height}, mean color ${JSON.stringify(video.mean)} within 20 of ${JSON.stringify(swatch)} (${video.frames} frames, ${video.framesDecoded} decoded${video.error ? `, error ${video.error}` : ""}${video.lastEncodingError ? `, ${video.lastEncodingError}` : ""})`)
        check(video.metadata?.sourceWidth === 64 && video.metadata?.sourceHeight === 48, `video through ${label}: per-frame metadata (${JSON.stringify(video.metadata)})`)
    }
    const audio = result.audio
    check(!audio.error && audio.mimeType === "audio/opus" && Math.abs(audio.peakHz - toneHz) <= 20 && audio.peakDb > -60 && audio.totalAudioEnergy > 0 && audio.encodingErrors === 0,
        `audio encoding: Opus track, the page hears the ${toneHz} Hz tone (peak ${audio.peakHz} Hz at ${audio.peakDb} dB, ${audio.bytesReceived} bytes, energy ${audio.totalAudioEnergy?.toFixed(3)}, ${audio.messages} messages${audio.error ? `, error ${audio.error}` : ""}${audio.lastEncodingError ? `, ${audio.lastEncodingError}` : ""})`)
    check(result.unknownError?.includes("unknown encoding") && result.unknownError.includes("text_uppercase") && result.unknownError.includes("rgb_swatch"), `bridge: an unknown encoding is rejected, naming the server's encodings (${result.unknownError})`)
    check(result.reliableVideoError?.includes("lossy"), `bridge: reliable delivery on a video channel is rejected (${result.reliableVideoError})`)
    const bridgeRefusal = await bridge.output.waitFor((line) => line.includes("unknown encoding") && line.includes("text_uppercase"), 3000).catch(() => null)
    check(result.rawClosed && bridgeRefusal !== null, `bridge: an unknown encoding is refused, listing the external ones (${bridgeRefusal?.replace(/.*rejected/, "rejected")})`)
} catch (error) {
    check(false, String(error))
    console.error(error)
}
await finish(scratch.toString())
