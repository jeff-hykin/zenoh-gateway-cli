#!/usr/bin/env -S deno run --allow-all --unstable-net
// Link lab: a dashboard to watch what a robot's streams do as the link under them changes. Real Chrome <-> a shaped
// UDP link (tests' shaped_link.js, reshaped live) <-> zenoh-gateway <-> a fake robot (examples/lab_peer.rs) publishing
// tf (reliable), video and a global map; the page publishes cmd_vel back. The page has the knobs: bandwidth, wobble,
// jitter, loss, dropouts/stalls, each source's rate and size, each subscription's priority and quality preference.
// Every 0.5 s's numbers are appended to <scratch>/lab.jsonl, with each knob change, for comparing runs later.
//
// Usage: deno run --allow-all --unstable-net tools/link_lab.js [--port 8787] [--gateway name=/path/to/zenoh-gateway ...] [--no-build]
//   --gateway (repeatable) offers more gateway builds to switch between on the page (A/B); "built" is this checkout's.

import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { parseArgs } from "jsr:@std/cli@1/parse-args"
import { TextLineStream } from "jsr:@std/streams@1/text-line-stream"
import { buildAll, cleanup, freePort, killOnCleanup, releaseDir, startBridge } from "../test/harness.js"
import { defaultQueueLimitBytes, links, shapedOffer } from "../test/shaped_link.js"

const args = parseArgs(Deno.args, { string: ["port", "gateway"], boolean: ["build"], collect: ["gateway"], default: { port: "8787", build: true } })
const scratch = $.path(await Deno.makeTempDir({ prefix: "zenoh-gateway-link-lab-" }))
const logPath = scratch.join("lab.jsonl")
const log = Deno.openSync(logPath.toString(), { create: true, append: true })
const encoder = new TextEncoder()
const record = (entry) => log.writeSync(encoder.encode(`${JSON.stringify({ t: Date.now(), ...entry })}\n`))

const webRoot = args.build ? await buildAll(scratch, ["lab_peer"]) : scratch.join("web")
if (!args.build) {
    const { buildWeb } = await import("./build_web.js")
    await buildWeb(webRoot.toString())
}
/** @type {Record<string, string>} */
const gateways = { built: releaseDir.join("zenoh-gateway").toString() }
for (const spec of /** @type {string[]} */ (args.gateway ?? [])) {
    const [name, path] = spec.split("=")
    if (!name || !path) {
        throw new Error(`--gateway ${spec}: expected name=/path/to/zenoh-gateway`)
    }
    gateways[name] = path
}

// the fake robot, its settings changed through stdin
const zenohPort = freePort()
const peerProcess = new Deno.Command(releaseDir.join("examples/lab_peer").toString(), { args: [`tcp/127.0.0.1:${zenohPort}`], stdin: "piped", stdout: "piped", stderr: "inherit" }).spawn()
killOnCleanup(peerProcess)
const peerInput = peerProcess.stdin.getWriter()
/** @type {{ sentAt: number, receivedAt: number, seq: number }[]} */
let cmdVels = []
const peerReady = Promise.withResolvers()
;(async () => {
    for await (const line of peerProcess.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())) {
        const cmdVel = line.match(/^CMDVEL (\S+) (.*)$/)
        if (line === "READY") {
            peerReady.resolve(undefined)
        } else if (cmdVel) {
            try {
                const payload = JSON.parse(cmdVel[2])
                cmdVels.push({ receivedAt: Number(cmdVel[1]), sentAt: payload.t, seq: payload.seq })
            } catch (error) {
                console.warn(`lab_peer: cmd_vel that is not the page's JSON (${error}): ${cmdVel[2]}`)
            }
        } else {
            console.warn(`lab_peer: ${line}`)
        }
    }
})().catch((error) => console.error(`lab_peer: reading its output: ${error}`))
const peerTimeout = setTimeout(() => peerReady.reject(new Error("lab_peer: no READY within 15 s")), 15000)
await peerReady.promise
clearTimeout(peerTimeout)

// the gateway (restarted to switch builds)
let gatewayName = "built"
let bridge = await startBridge(scratch, zenohPort, webRoot, [], gateways[gatewayName])
/** @type {Awaited<ReturnType<typeof shapedOffer>>["shaper"][]} */
let shapers = []
async function switchGateway(name) {
    if (!gateways[name]) {
        throw new Error(`no gateway build named ${name}`)
    }
    bridge.process.kill("SIGTERM")
    await bridge.process.status
    shapers.forEach((shaper) => shaper.stop())
    shapers = []
    gatewayName = name
    bridge = await startBridge(scratch, zenohPort, webRoot, [], gateways[name])
}

/** A shaped_link.js link as the lab's knobs (the uplink's rate is its own knob, kept). */
const presetSettings = ({ down }) => ({
    bytesPerSec: down.bytesPerSec,
    oneWayDelayMs: down.oneWayDelayMs ?? 0,
    jitterMs: down.jitterMs ?? 0,
    jitterPeriodMs: down.jitterPeriodMs ?? 0,
    spikeChance: down.spikeChance ?? 0,
    spikeMs: down.spikeMs ?? 0,
    lossRate: down.lossRate ?? 0,
    queueLimitBytes: down.queueLimitBytes ?? defaultQueueLimitBytes,
    wobbleAmount: 0,
})
// Chrome DevTools' throttling presets (devtools-frontend NetworkManager.ts, factors included): kbit/s down and up, RTT ms; no loss or jitter
const devtools = (name, downKbit, upKbit, rttMs) => [name, { bytesPerSec: (downKbit * 1000) / 8, upBytesPerSec: (upKbit * 1000) / 8, oneWayDelayMs: rttMs / 2 }]
/** @type {Record<string, object>} */
const presets = {
    ...Object.fromEntries(Object.entries(links).map(([name, link]) => [name, presetSettings(link)])),
    ...Object.fromEntries([
        devtools("DevTools Fast 4G", 9000 * 0.9, 1500 * 0.9, 60 * 2.75),
        devtools("DevTools Slow 4G", 1600 * 0.9, 750 * 0.9, 150 * 3.75),
        devtools("DevTools Slow 3G", 500 * 0.8, 500 * 0.8, 400 * 5),
    ].map(([name, preset]) => [name, { ...presetSettings({ down: {} }), ...preset }])),
}

// the link: what the page asks for, and what the shapers are set to from it every tick; starts as shaped_link.js's jitter50
const settings = {
    ...presetSettings(links.jitter50),
    // the uplink starts as fast as the downlink
    upBytesPerSec: links.jitter50.down.bytesPerSec,
    // bandwidth wobble: +-amount (0..1) of the bandwidth over periodSec, "sine" or "random" (a new level each period)
    wobblePeriodSec: 4,
    wobbleMode: "sine",
}
/** @type {{ kind: "dropout" | "stall", until: number } | null} */
let outage = null
/** shared by every shaper, read per packet */
const link = { down: {}, up: {} }
let randomLevel = 1
let randomDrawnAt = 0
function applySettings(now) {
    let factor = 1
    if (settings.wobbleAmount > 0) {
        if (settings.wobbleMode === "sine") {
            factor = 1 + settings.wobbleAmount * Math.sin((2 * Math.PI * now) / (settings.wobblePeriodSec * 1000))
        } else {
            if (now - randomDrawnAt >= settings.wobblePeriodSec * 1000) {
                randomDrawnAt = now
                randomLevel = 1 + settings.wobbleAmount * (2 * Math.random() - 1)
            }
            factor = randomLevel
        }
    }
    const out = outage && outage.until > now ? outage.kind : null
    const shared = { oneWayDelayMs: settings.oneWayDelayMs, jitterMs: settings.jitterMs, jitterPeriodMs: settings.jitterPeriodMs, spikeChance: settings.spikeChance, spikeMs: settings.spikeMs, queueLimitBytes: settings.queueLimitBytes }
    // a dropout loses every packet; a stall delivers nothing but queues (until the queue overflows)
    const lossRate = out === "dropout" ? 1 : settings.lossRate
    Object.assign(link.down, shared, { bytesPerSec: out === "stall" ? 0 : settings.bytesPerSec * factor, lossRate })
    Object.assign(link.up, shared, { bytesPerSec: out === "stall" ? 0 : settings.upBytesPerSec, lossRate })
    return { effectiveBytesPerSec: link.down.bytesPerSec, outage: out }
}
applySettings(Date.now())
// often enough that a sine wobble moves in small steps (a 0.5 s period, the knob's shortest, gets 10 per period)
setInterval(() => applySettings(Date.now()), 50)

// what the link did each tick, for the page
let last = { at: performance.now(), bytes: 0, dropped: 0, lost: 0, upBytes: 0 }
/** @type {Set<ReadableStreamDefaultController>} */
const listeners = new Set()
setInterval(() => {
    const now = performance.now()
    const totals = shapers.reduce((sum, shaper) => ({
        bytes: sum.bytes + shaper.down.bytes,
        dropped: sum.dropped + shaper.down.dropped + shaper.up.dropped,
        lost: sum.lost + shaper.down.lost + shaper.up.lost,
        upBytes: sum.upBytes + shaper.up.bytes,
        queued: sum.queued + shaper.downQueuedBytes(),
    }), { bytes: 0, dropped: 0, lost: 0, upBytes: 0, queued: 0 })
    const seconds = (now - last.at) / 1000
    const rate = (name) => Math.max(0, (totals[name] - last[name]) / seconds)
    const { effectiveBytesPerSec, outage: out } = applySettings(Date.now())
    const tick = {
        type: "link",
        gateway: gatewayName,
        setBytesPerSec: settings.bytesPerSec,
        effectiveBytesPerSec,
        outage: out,
        deliveredBytesPerSec: rate("bytes"),
        upBytesPerSec: rate("upBytes"),
        droppedPerSec: rate("dropped"),
        lostPerSec: rate("lost"),
        queueMs: effectiveBytesPerSec > 0 ? (totals.queued / effectiveBytesPerSec) * 1000 : null,
        queuedBytes: totals.queued,
        cmdVel: cmdVels,
    }
    cmdVels = []
    last = { at: now, ...totals }
    const message = encoder.encode(`data: ${JSON.stringify(tick)}\n\n`)
    for (const controller of listeners) {
        try {
            controller.enqueue(message)
        } catch (error) {
            // a page that went away without cancelling its stream
            console.warn(`lab events: dropping a listener: ${error}`)
            listeners.delete(controller)
        }
    }
}, 250)

const page = $.path(import.meta.dirname ?? ".").join("link_lab.html")
const port = Number(args.port)
Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, async (request) => {
    const url = new URL(request.url)
    try {
        switch (url.pathname) {
            case "/":
                // read each time: edit the page, reload
                return new Response(page.readTextSync(), { headers: { "content-type": "text/html; charset=utf-8" } })
            case "/offer": {
                const { answer, shaper } = await shapedOffer(request, bridge.url, link)
                shapers.push(shaper)
                return answer
            }
            case "/lab/state":
                return Response.json({ settings, presets, stallPeriodMs: links.wifi.down.jitterPeriodMs, gateways: Object.keys(gateways), gateway: gatewayName, log: logPath.toString() })
            case "/lab/link": {
                const changes = await request.json()
                Object.assign(settings, changes)
                record({ type: "knob", target: "link", changes })
                return Response.json(settings)
            }
            case "/lab/outage": {
                const { kind, seconds } = await request.json()
                outage = { kind, until: Date.now() + seconds * 1000 }
                record({ type: "knob", target: "outage", changes: { kind, seconds } })
                return Response.json({ ok: true })
            }
            case "/lab/source": {
                const { stream, field, value } = await request.json()
                await peerInput.write(encoder.encode(`SET ${stream} ${field} ${Number(value)}\n`))
                record({ type: "knob", target: `source/${stream}`, changes: { [field]: value } })
                return Response.json({ ok: true })
            }
            case "/lab/gateway": {
                const { name } = await request.json()
                await switchGateway(name)
                record({ type: "knob", target: "gateway", changes: { name } })
                return Response.json({ ok: true })
            }
            case "/lab/record": {
                // the page's per-tick numbers and its own knob changes
                record(await request.json())
                return Response.json({ ok: true })
            }
            case "/lab/events": {
                let controller
                const body = new ReadableStream({
                    start(streamController) {
                        controller = streamController
                        listeners.add(controller)
                    },
                    cancel() {
                        listeners.delete(controller)
                    },
                })
                return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
            }
        }
        // everything else (the client, the gateway's own endpoints) is the gateway's
        return await fetch(`${bridge.url}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body: request.body })
    } catch (error) {
        console.error(`link lab: ${request.method} ${url.pathname}: ${error}`)
        return new Response(String(error), { status: 500 })
    }
})

console.log(`\nlink lab: http://127.0.0.1:${port}/   (log: ${logPath})`)
const stop = async () => {
    await cleanup()
    Deno.exit(0)
}
Deno.addSignalListener("SIGINT", stop)
Deno.addSignalListener("SIGTERM", stop)
