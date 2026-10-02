#!/usr/bin/env -S deno run --allow-all
// Bandwidth allocation end-to-end, with the bridge's budget capped (--max-bandwidth-bytes-per-sec):
// streams flex-shrink by demand / bandwidthPriority (equal priorities equally, priority 0 first), and the quality/Hz
// tradeoff of a transcoded (H.264) stream.
// Usage: deno run --allow-all test/allocation.js

import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { buildAll, check, finish, fixtureKey, fixturesDir, launchBrowser, loadManifest, machineLoad, startBridge, startPeer } from "./harness.js"

const scratch = $.path(await Deno.makeTempDir({ prefix: "zenoh-web-allocation-" }))
console.log(`machine load at start: ${await machineLoad()}`)

const rawBudget = 480_000
const videoBudget = 12_000
const videoEntry = loadManifest().entries.find((entry) => entry.file === "dimos/image_rgb8.bin")
if (!videoEntry) {
    throw new Error("fixture dimos/image_rgb8.bin missing from manifest")
}
const videoKey = fixtureKey(videoEntry).replace("/fixture/", "/allocation/")

try {
    const webRoot = await buildAll(scratch)
    $.logStep("test peer: three 20 KB streams at 50 Hz, one 320x240 image stream at 20 Hz")
    const peer = await startPeer([
        ...["a", "b", "c"].flatMap((name) => ["--synthetic", `alloc/${name}=20000@50`]),
        "--publish", `${videoKey}=${fixturesDir.join(videoEntry.file)}@20`,
    ])
    const rawBridge = await startBridge(scratch, peer.zenohPort, webRoot, ["--max-bandwidth-bytes-per-sec", String(rawBudget)])
    const videoBridge = await startBridge(scratch, peer.zenohPort, webRoot, ["--max-bandwidth-bytes-per-sec", String(videoBudget)])
    await $.sleep(1000)
    const browser = await launchBrowser()
    const page = await browser.newPage(`${rawBridge.url}/test/blank.html`)

    /** Three 400 KB/s streams with these subscribe options, measured under the capped budget. */
    const measureRaw = (streams) => page.evaluate(async (bridgeUrl, streams) => {
        const { connect } = await import("/client/zenoh_web.js")
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const client = await connect(bridgeUrl)
        const counts = { a: 0, b: 0, c: 0 }
        const bytes = { a: 0, b: 0, c: 0 }
        let measuring = false
        const subscriptions = Object.entries(streams).map(([name, options]) => client.subscribe(`alloc/${name}`, options, (message) => {
            if (measuring) {
                counts[name]++
                bytes[name] += message.bytes.length
            }
        }))
        await Promise.all(subscriptions.map((subscription) => subscription.ready()))
        // the allocator needs a few rounds to measure source rates and sizes
        await sleep(3000)
        measuring = true
        const seconds = 6
        await sleep(seconds * 1000)
        measuring = false
        await client.pollStats()
        const result = {
            hz: Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, count / seconds])),
            bytesPerSec: Object.values(bytes).reduce((sum, value) => sum + value, 0) / seconds,
            allocation: Object.fromEntries(subscriptions.map((subscription, index) => [Object.keys(streams)[index], subscription.bridgeStats?.allocation])),
            bandwidth: client.bridgeStats?.bandwidth,
        }
        client.close()
        await sleep(500)
        return result
    }, { args: [rawBridge.url, streams] })

    $.logStep(`equal shrink: budget ${rawBudget} B/s for 3 x 400 KB/s`)
    const raw = await measureRaw({ a: { maxHz: 20 }, b: { maxHz: 20 }, c: { maxHz: 20 } })
    console.log(JSON.stringify(raw, null, 1))
    const { hz, allocation } = raw
    // 480 KB/s over three streams wanting 400 KB/s each: 160 KB/s = 8 Hz of 20 KB messages apiece
    check(Object.values(hz).every((rate) => rate >= 6 && rate <= 10), `every stream shrinks to about 8 Hz of 20 (a ${hz.a.toFixed(2)}, b ${hz.b.toFixed(2)}, c ${hz.c.toFixed(2)} Hz)`)
    check(Object.values(allocation).every((stream) => stream?.constrained && Math.abs(stream.hzFraction - Object.values(allocation)[0].hzFraction) < 0.05),
        `stats show each stream shrunk by the same fraction (${Object.values(allocation).map((stream) => stream?.hzFraction?.toFixed(2)).join(", ")})`)
    check(raw.bandwidth?.budgetBytesPerSec === rawBudget && raw.bandwidth?.capBytesPerSec === rawBudget && raw.bandwidth?.constrained === true, `frontend budget is the cap (${JSON.stringify(raw.bandwidth)})`)
    check(raw.bytesPerSec <= rawBudget * 1.1, `delivered payload stays within the budget (${raw.bytesPerSec.toFixed(0)} B/s <= ${rawBudget} + 10%)`)

    $.logStep("unequal shrink: bandwidthPriority 10 / 0.1 / 0.1")
    const weighted = await measureRaw({ a: { bandwidthPriority: 10, maxHz: 20 }, b: { bandwidthPriority: 0.1, maxHz: 20 }, c: { bandwidthPriority: 0.1, maxHz: 20 } })
    console.log(JSON.stringify(weighted.hz))
    // the 720 KB/s deficit splits by demand / priority, 1 : 100 : 100, so a keeps ~19.8 Hz and b, c fall to ~2.1 Hz
    check(weighted.hz.a >= 17 && weighted.hz.b <= 3.5 && weighted.hz.c <= 3.5,
        `the high-priority stream keeps its rate, the low-priority ones shrink (a ${weighted.hz.a.toFixed(2)}, b ${weighted.hz.b.toFixed(2)}, c ${weighted.hz.c.toFixed(2)} Hz; allocation a ${weighted.allocation.a?.hz?.toFixed(2)}, b ${weighted.allocation.b?.hz?.toFixed(2)} Hz)`)

    $.logStep("priority 0 shrinks first: bandwidthPriority 0 / 1 / 1")
    const firstToShrink = await measureRaw({ a: { bandwidthPriority: 0, maxHz: 20 }, b: { maxHz: 20 }, c: { maxHz: 20 } })
    console.log(JSON.stringify(firstToShrink.hz))
    // a gives up all of its 400 KB/s first; b and c split the remaining 320 KB/s deficit (240 KB/s = 12 Hz each)
    check(firstToShrink.hz.a <= 1 && firstToShrink.hz.b >= 10 && firstToShrink.hz.b <= 14 && firstToShrink.hz.c >= 10 && firstToShrink.hz.c <= 14,
        `a priority-0 stream gives up everything before the others give up anything more (a ${firstToShrink.hz.a.toFixed(2)}, b ${firstToShrink.hz.b.toFixed(2)}, c ${firstToShrink.hz.c.toFixed(2)} Hz)`)

    $.logStep(`quality/Hz tradeoff: one H.264 stream wanting ~29 KB/s (maxBitrate 230.4 kbit/s), budget ${videoBudget} B/s`)
    await page.goto(`${videoBridge.url}/test/blank.html`)
    const tradeoffs = []
    for (const tradeoff of [0, 1]) {
        tradeoffs.push(await page.evaluate(async (bridgeUrl, key, tradeoff) => {
            const { connect } = await import("/client/zenoh_web.js")
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            const client = await connect(bridgeUrl)
            const frames = []
            let measuring = false
            // 0.15 bit/pixel at 320x240 and 20 Hz
            const subscription = client.subscribe(key, { codec: "dimos-image", maxHz: 20, minQuality: 0.2, qualityToHzTradeoff: tradeoff, maxBitrate: 230_400 }, (message) => {
                if (measuring) {
                    frames.push(message.video)
                }
            })
            await subscription.ready()
            const element = document.createElement("video")
            element.muted = true
            element.srcObject = subscription.mediaStream
            document.body.append(element)
            await element.play().catch(() => {})
            await sleep(3000)
            measuring = true
            const decodedBefore = element.getVideoPlaybackQuality().totalVideoFrames
            const seconds = 5
            await sleep(seconds * 1000)
            measuring = false
            const decoded = element.getVideoPlaybackQuality().totalVideoFrames - decodedBefore
            await client.pollStats()
            const result = {
                tradeoff,
                hz: frames.length / seconds,
                decodedHz: decoded / seconds,
                widths: [...new Set(frames.map((frame) => frame.width))],
                videoWidth: element.videoWidth,
                quality: frames.at(-1)?.quality,
                allocation: subscription.bridgeStats?.allocation,
                bandwidth: client.bridgeStats?.bandwidth,
            }
            element.remove()
            client.close()
            await sleep(500)
            return result
        }, { args: [videoBridge.url, videoKey, tradeoff] }))
    }
    console.log(JSON.stringify(tradeoffs, null, 1))
    const [keepQuality, keepHz] = tradeoffs
    check(keepQuality.videoWidth === 320 && keepQuality.widths.join() === "320" && keepQuality.hz < 12 && keepQuality.hz > 4,
        `tradeoff 0 keeps quality, Hz drops (${keepQuality.videoWidth}px wide, ${keepQuality.hz.toFixed(1)} Hz sent, ${keepQuality.decodedHz.toFixed(1)} Hz decoded, quality ${keepQuality.quality?.toFixed(2)})`)
    // fewer bits per frame (a still fixture's frames are tiny either way, so the frames' quality says it), at full size:
    // 0.06 bit/pixel is above the 0.05 floor where the picture would shrink
    check(keepHz.hz >= 16 && keepHz.quality < keepQuality.quality && keepHz.widths.join() === "320",
        `tradeoff 1 keeps Hz, quality drops (${keepHz.widths.join()}px wide, quality ${keepHz.quality?.toFixed(2)} vs ${keepQuality.quality?.toFixed(2)}, ${keepHz.hz.toFixed(1)} Hz sent, ${keepHz.decodedHz.toFixed(1)} Hz decoded)`)
    check(keepQuality.allocation?.constrained && keepHz.allocation?.constrained && keepQuality.allocation.quality > keepHz.allocation.quality && keepQuality.allocation.hz < keepHz.allocation.hz,
        `allocations: tradeoff 0 -> q ${keepQuality.allocation?.quality} @ ${keepQuality.allocation?.hz?.toFixed(1)} Hz, tradeoff 1 -> q ${keepHz.allocation?.quality} @ ${keepHz.allocation?.hz?.toFixed(1)} Hz`)

} catch (error) {
    check(false, String(error))
    console.error(error)
}
await finish(scratch.toString())
