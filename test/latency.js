#!/usr/bin/env -S deno run --allow-all --unstable-net
// Latency of a strict-priority stream under bulk load, over a real bottleneck: test/shaped_link.js
// between Chrome and the bridge (2 MB/s bridge->browser, 1 MB drop-tail queue, 5 ms each way).
// Usage: deno run --allow-all --unstable-net test/latency.js

import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { buildAll, check, finish, launchBrowser, machineLoad, startBridge, startPeer } from "./harness.js"
import { startShapedLink } from "./shaped_link.js"

const scratch = $.path(await Deno.makeTempDir({ prefix: "zenoh-gateway-latency-" }))
console.log(`machine load at start: ${await machineLoad()}`)

const linkBytesPerSec = 2_000_000
const queueLimitBytes = 1_000_000
const oneWayDelayMs = 5
const bulkStreams = 5

/** bridge->browser rate limited behind a drop-tail queue, a fixed delay both ways */
const link = { down: { bytesPerSec: linkBytesPerSec, queueLimitBytes, oneWayDelayMs }, up: { oneWayDelayMs } }
/** per wall-clock second: the shaper queue's peak, in ms of link time */
const queuePeakBySecond = new Map()
let maxQueueMs = 0

try {
    const webRoot = await buildAll(scratch)
    $.logStep(`test peer: an important 200 B stream at 50 Hz, ${bulkStreams} bulk streams of 200 KB at 10 Hz (${bulkStreams * 2} MB/s)`)
    const peer = await startPeer([
        "--synthetic", "latency/important=200@50",
        ...Array.from({ length: bulkStreams }, (_, index) => ["--synthetic", `latency/bulk/${index}=200000@10`]).flat(),
    ])
    const bridge = await startBridge(scratch, peer.zenohPort, webRoot)
    const shaped = startShapedLink(bridge.url, link)
    const proxyUrl = shaped.url
    // each second's peak: read the shaper's running maximum, then restart it
    setInterval(() => {
        for (const shaper of shaped.shapers) {
            const second = Math.floor(Date.now() / 1000) - 1
            queuePeakBySecond.set(second, Math.max(queuePeakBySecond.get(second) ?? 0, shaper.down.maxQueueMs))
            maxQueueMs = Math.max(maxQueueMs, shaper.down.maxQueueMs)
            shaper.down.maxQueueMs = 0
        }
    }, 1000)
    await $.sleep(1000)
    const browser = await launchBrowser()
    const page = await browser.newPage(`${proxyUrl}/test/blank.html`)
    $.logStep(`shaped link: ${linkBytesPerSec / 1e6} MB/s bridge->browser, ${queueLimitBytes / 1e6} MB queue, ${oneWayDelayMs} ms each way`)
    const results = await page.evaluate(async (proxyUrl, bulkStreams) => {
        const { connect, Priority } = await import("/client/zenoh_gateway.js")
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const client = await connect(proxyUrl, { heartbeatHz: 20, heartbeatMisses: 100 })
        /** p50/p99/max of the important stream's latency (arrival - publisher send time, same clock) over `seconds` */
        async function measureImportant(options, seconds) {
            const latencies = []
            const worstBySecond = {}
            let measuring = false
            const subscription = client.subscribe("latency/important", options, (message) => {
                if (measuring) {
                    const latency = Date.now() - new DataView(message.bytes.buffer, message.bytes.byteOffset, 8).getFloat64(0, true)
                    latencies.push(latency)
                    const second = Math.floor(Date.now() / 1000)
                    worstBySecond[second] = Math.max(worstBySecond[second] ?? 0, Math.round(latency))
                }
            })
            const timeline = []
            const sampler = setInterval(async () => {
                await client.pollStats().catch((error) => console.warn(`pollStats: ${error}`))
                const bandwidth = client.gatewayStats?.bandwidth
                timeline.push({ second: Math.floor(Date.now() / 1000), estimate: Math.round(bandwidth?.dataEstimateBytesPerSec ?? 0), budget: Math.round(bandwidth?.budgetBytesPerSec ?? 0), queueDelayMs: bandwidth?.queueDelayMs, delayEvents: bandwidth?.delayEvents })
            }, 1000)
            await subscription.ready()
            await sleep(2000)
            measuring = true
            await sleep(seconds * 1000)
            measuring = false
            clearInterval(sampler)
            await client.pollStats()
            const bridgeSide = subscription.gatewayStats?.stats
            subscription.close()
            latencies.sort((a, b) => a - b)
            const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]
            return { count: latencies.length, p50: at(0.5), p99: at(0.99), max: latencies.at(-1), bridgeMaxSendLagMs: bridgeSide?.maxSendLagMs, bridgeMaxReceiveLagMs: bridgeSide?.maxReceiveLagMs, worstBySecond, timeline }
        }
        const out = {}
        out.alone = await measureImportant({ priority: Priority.INTERACTIVE_HIGH }, 10)
        const bulkBytes = Array(bulkStreams).fill(0)
        const bulk = Array.from({ length: bulkStreams }, (_, index) => client.subscribe(`latency/bulk/${index}`, { delivery: "latest" }, (message) => {
            bulkBytes[index] += message.bytes.length
        }))
        await Promise.all(bulk.map((subscription) => subscription.ready()))
        await sleep(5000)
        bulkBytes.fill(0)
        const started = performance.now()
        out.loaded = await measureImportant({ priority: Priority.INTERACTIVE_HIGH }, 10)
        out.bulkBytesPerSec = bulkBytes.reduce((sum, value) => sum + value, 0) / ((performance.now() - started) / 1000)
        await client.pollStats()
        out.bandwidth = client.gatewayStats?.bandwidth
        out.bulkAllocation = bulk[0].gatewayStats?.allocation
        // contrast, not asserted: the same stream without strict priority shares the bulk path
        out.notStrict = await measureImportant({}, 8)
        bulk.forEach((subscription) => subscription.close())
        client.close()
        return out
    }, { args: [proxyUrl, bulkStreams] })
    for (const phase of ["alone", "loaded", "notStrict"]) {
        console.log(`${phase} timeline (second: worst important latency ms | shaper queue peak ms | bridge estimate, budget B/s, queue delay ms, delay events):`)
        for (const entry of results[phase].timeline) {
            console.log(`  ${entry.second % 1000}: ${results[phase].worstBySecond[entry.second] ?? "-"} | ${(queuePeakBySecond.get(entry.second) ?? 0).toFixed(1)} | ${entry.estimate} ${entry.budget} ${entry.queueDelayMs?.toFixed?.(1)} ${entry.delayEvents}`)
        }
        delete results[phase].timeline
        delete results[phase].worstBySecond
    }
    const shaper = shaped.shapers.at(-1)
    console.log(JSON.stringify({ ...results, shaper: { downstreamBytes: shaper?.down.bytes, dropped: shaper?.down.dropped, maxQueueBytes: shaper?.down.maxQueueBytes, maxQueueMs } }, null, 1))
    const { alone, loaded, notStrict } = results
    const increase = loaded.p99 - alone.p99
    check(alone.count > 400 && loaded.count > 400, `important stream delivers through the shaper (${alone.count} alone, ${loaded.count} loaded, 50 Hz x 10 s)`)
    check(results.bulkBytesPerSec > linkBytesPerSec * 0.3, `bulk streams really load the link (${(results.bulkBytesPerSec / 1e6).toFixed(2)} MB/s of ${linkBytesPerSec / 1e6} MB/s)`)
    check(increase < 20, `strict-priority p99 latency grows < 20 ms under ${bulkStreams} bulk streams: alone p50 ${alone.p50} / p99 ${alone.p99} / max ${alone.max} ms, loaded p50 ${loaded.p50} / p99 ${loaded.p99} / max ${loaded.max} ms (+${increase} ms)`)
    console.log(`contrast (not asserted): same stream without strict priority under load: p50 ${notStrict.p50} / p99 ${notStrict.p99} / max ${notStrict.max} ms; shaper queue peaked at ${maxQueueMs.toFixed(0)} ms (${shaper?.down.maxQueueBytes} bytes), dropped ${shaper?.down.dropped} packets`)
} catch (error) {
    check(false, String(error))
    console.error(error)
}
await finish(scratch.toString())
