#!/usr/bin/env -S deno run --allow-all
// End-to-end: tokens and grants (--auth-file), revocation, leases, and ICE/TURN configuration.
// Usage: deno run --allow-all test/auth.js   (the TURN part needs coturn's turnserver on PATH or TURNSERVER=<path>)

import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { buildAll, check, finish, freePort, killOnCleanup, launchBrowser, machineLoad, startBridge, startPeer } from "./harness.js"

const scratch = $.path(await Deno.makeTempDir({ prefix: "zenoh-web-auth-" }))
console.log(`machine load at start: ${await machineLoad()}`)

const tokens = {
    reader: "read",
    writer: "write",
    leaser: "lease",
    leaser2: "lease",
    admin: { subscribe: ["**"], publish: ["**"], leaseGroups: ["*"], forceExpire: true },
    revokable: "read",
    narrow: { subscribe: ["test/open/**"], listTopics: ["test/open/**"] },
}
const authFile = scratch.join("tokens.json5")
/** @param {object} tokens */
const writeAuthFile = (tokens) => authFile.writeTextSync(JSON.stringify({ tokens, leaseGroups: { cmd: ["test/frombrowser/cmd/**"] } }, null, 4))

try {
    writeAuthFile(tokens)
    const webRoot = await buildAll(scratch)
    const peer = await startPeer(["--synthetic", "test/open/data=16@20"])
    const recvCount = (/** @type {string} */ key, /** @type {string} */ payload) => peer.output.lines.filter((line) => line === `RECV test/frombrowser/${key} ${payload}`).length
    const bridge = await startBridge(scratch, peer.zenohPort, webRoot, ["--auth-file", authFile.toString()])
    await $.sleep(1000)
    const browser = await launchBrowser()
    const page = await browser.newPage(`${bridge.url}/test/blank.html`)

    $.logStep("tokens and grants")
    const grants = await page.evaluate(async (bridgeUrl) => {
        const { connect } = await import("/client/zenoh_web.js")
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const outcome = (promise) => promise.then(() => "accepted", (error) => error.message)
        const out = {}
        out.noToken = await outcome(connect(bridgeUrl, { reconnect: false }))
        out.badToken = await outcome(connect(bridgeUrl, { token: "nope", reconnect: false }))
        out.iceNoToken = (await fetch(`${bridgeUrl}/zenoh-web/ice`)).status

        const reader = await connect(bridgeUrl, { token: "reader" })
        let received = 0
        const subscription = reader.subscribe("test/open/data", {}, () => received++)
        out.readerSub = await outcome(subscription.ready())
        const publisher = reader.publisher("test/frombrowser/reader", { delivery: "reliable" })
        out.readerPub = await outcome(publisher.ready())
        out.readerGet = (await reader.get("test/queryable")).length
        await sleep(1000)
        out.readerReceived = received
        reader.close()

        const narrow = await connect(bridgeUrl, { token: "narrow" })
        out.narrowSub = await outcome(narrow.subscribe("test/open/data", {}, () => {}).ready())
        out.narrowWide = await outcome(narrow.subscribe("test/**", {}, () => {}).ready())
        out.narrowGet = await outcome(narrow.get("test/queryable"))
        out.narrowTopics = (await narrow.listTopics("**", { probeMs: 800 })).map((topic) => topic.key)
        narrow.close()

        const writer = await connect(bridgeUrl, { token: "writer" })
        const written = writer.publisher("test/frombrowser/writer", { delivery: "reliable" })
        out.writerPub = await outcome(written.ready())
        written.put("from-writer")
        await sleep(300)
        writer.close()
        return out
    }, { args: [bridge.url] })
    console.log("grants:", JSON.stringify(grants))
    check(grants.noToken.includes("gateway refused the token") && grants.noToken.includes("a token is required"), `no token is refused when auth is required (${grants.noToken})`)
    check(grants.badToken.includes("unknown token"), `an unknown token is refused (${grants.badToken})`)
    check(grants.iceNoToken === 401, `GET /zenoh-web/ice needs the token too (${grants.iceNoToken})`)
    check(grants.readerSub === "accepted" && grants.readerReceived > 5, `a read token subscribes (${grants.readerSub}, ${grants.readerReceived} messages)`)
    check(grants.readerPub.includes("not authorized to publish \"test/frombrowser/reader\""), `a read token can't publish (${grants.readerPub})`)
    check(grants.readerGet === 1, "a read token queries")
    check(grants.narrowSub === "accepted" && grants.narrowWide.includes("not authorized to subscribe \"test/**\""), `a subscription wider than the grant is refused (${grants.narrowWide})`)
    check(grants.narrowGet.includes("not authorized to query"), `a grant without query refuses get (${grants.narrowGet})`)
    check(grants.narrowTopics.length > 0 && grants.narrowTopics.every((key) => key.startsWith("test/open/")), `listTopics shows only the grant's keys (${grants.narrowTopics})`)
    await $.sleep(300)
    check(grants.writerPub === "accepted" && recvCount("writer", "from-writer") === 1, "a write token publishes")

    $.logStep("revocation")
    const revoking = page.evaluate(async (bridgeUrl) => {
        const { connect } = await import("/client/zenoh_web.js")
        const client = await connect(bridgeUrl, { token: "revokable" })
        const states = []
        client.onState((state) => states.push(state))
        window.revokedClient = client
        window.revokedStates = states
        return client.state
    }, { args: [bridge.url] })
    check(await revoking === "connected", "the revokable token connects")
    const { revokable: _, ...withoutRevokable } = tokens
    writeAuthFile(withoutRevokable)
    const revokedLine = await bridge.output.waitFor((line) => line.includes("revoked 1 connection"), 5000).then(() => true, () => false)
    await $.sleep(3000)
    const revoked = await page.evaluate(() => ({ state: window.revokedClient.state, states: window.revokedStates }))
    console.log("revoked:", JSON.stringify(revoked))
    check(revokedLine, "removing a token from the auth file revokes its connection")
    check(revoked.state === "lost" && revoked.states.filter((state) => state === "connecting").length <= 1, `the revoked client is dropped and its reconnect refused (${revoked.states})`)
    const reconnect = await page.evaluate(async (bridgeUrl) => {
        const { connect } = await import("/client/zenoh_web.js")
        return await connect(bridgeUrl, { token: "revokable", reconnect: false }).then(() => "accepted", (error) => error.message)
    }, { args: [bridge.url] })
    check(reconnect.includes("unknown token"), `a revoked token can't connect again (${reconnect})`)

    $.logStep("leases")
    const leases = await page.evaluate(async (bridgeUrl) => {
        const { connect } = await import("/client/zenoh_web.js")
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const outcome = (promise) => promise.then(() => "accepted", (error) => error.message)
        const out = {}
        const heartbeat = { heartbeatHz: 10, heartbeatMisses: 3 }
        const holder = await connect(bridgeUrl, { token: "leaser", ...heartbeat })
        const other = await connect(bridgeUrl, { token: "leaser2", ...heartbeat })
        const lease = await holder.lease("cmd", { maxSeconds: 60 })
        out.lease = { keys: lease.keys, expiresInMs: lease.expiresInMs }
        const lost = []
        lease.onLost((reason) => lost.push(reason))

        const mine = holder.publisher("test/frombrowser/cmd/vel", { delivery: "reliable" })
        const theirs = other.publisher("test/frombrowser/cmd/vel", { delivery: "reliable" })
        await Promise.all([mine.ready(), theirs.ready()])
        mine.put("holder-1")
        theirs.put("other-blocked-1")
        theirs.put("other-blocked-2")
        await sleep(500)
        out.blocked = theirs.blocked
        await other.pollStats()
        out.rejectedLeased = theirs.gatewayStats?.stats.rejectedLeased
        out.secondLease = await outcome(other.lease("cmd"))
        out.overlapping = await outcome(other.lease("mine", { keys: ["test/frombrowser/cmd/*"] }))
        const writer = await connect(bridgeUrl, { token: "writer", ...heartbeat })
        out.writerLease = await outcome(writer.lease("cmd"))
        writer.close()

        // the holder's heartbeat stops: the lease ends and the other client's puts go through
        holder.pauseHeartbeat()
        await sleep(1200)
        out.lostAfterPause = [...lost]
        theirs.put("other-after-heartbeat")
        await sleep(300)
        out.blockedAfter = theirs.blocked
        holder.resumeHeartbeat()
        await sleep(300)

        // maxSeconds
        const short = await other.lease("cmd", { maxSeconds: 0.5 })
        const shortLost = []
        short.onLost((reason) => shortLost.push(reason))
        await sleep(1000)
        out.shortLost = shortLost
        out.afterShort = await outcome(holder.lease("cmd").then((again) => again.release()))

        // force-expire needs the right
        const retaken = await holder.lease("cmd")
        const retakenLost = []
        retaken.onLost((reason) => retakenLost.push(reason))
        out.expireWithoutRight = await outcome(other.expireLease("cmd"))
        const admin = await connect(bridgeUrl, { token: "admin" })
        out.expireWithRight = await outcome(admin.expireLease("cmd"))
        await sleep(300)
        out.retakenLost = retakenLost
        theirs.put("other-after-force")
        await sleep(300)
        holder.close()
        other.close()
        admin.close()
        return out
    }, { args: [bridge.url] })
    console.log("leases:", JSON.stringify(leases))
    check(leases.lease.keys.join() === "test/frombrowser/cmd/**" && leases.lease.expiresInMs === 60000, `a lease on the server's group (${JSON.stringify(leases.lease)})`)
    check(recvCount("cmd/vel", "holder-1") === 1, "the holder publishes on the leased keys")
    check(recvCount("cmd/vel", "other-blocked-1") + recvCount("cmd/vel", "other-blocked-2") === 0 && leases.rejectedLeased === 2, `another client's puts are dropped (rejectedLeased=${leases.rejectedLeased})`)
    check(leases.blocked?.includes("is leased by another client (group \"cmd\")"), `the blocked publisher hears why (${leases.blocked})`)
    check(leases.secondLease.includes("held by another client") && leases.overlapping.includes("held by another client"), `a second lease on the same or overlapping keys is refused (${leases.secondLease} / ${leases.overlapping})`)
    check(leases.writerLease.includes("not authorized to lease"), `a grant without lease groups can't lease (${leases.writerLease})`)
    check(leases.lostAfterPause.join() === "heartbeat", `the lease ends when the holder's heartbeat stops (${leases.lostAfterPause})`)
    check(recvCount("cmd/vel", "other-after-heartbeat") === 1 && leases.blockedAfter === null, "then the other client publishes again")
    check(leases.shortLost.join() === "maxSeconds" && leases.afterShort === "accepted", `a lease ends at maxSeconds (${leases.shortLost})`)
    check(leases.expireWithoutRight.includes("not authorized to force-expire"), `force-expire without the right is refused (${leases.expireWithoutRight})`)
    check(leases.expireWithRight === "accepted" && leases.retakenLost.length === 1 && leases.retakenLost[0].startsWith("force-expired by peer"), `force-expire with the right ends the holder's lease (${leases.retakenLost})`)
    check(recvCount("cmd/vel", "other-after-force") === 1, "after a force-expire the keys are free")

    $.logStep("ICE/TURN configuration")
    const turnserver = Deno.env.get("TURNSERVER") ?? (await $`which turnserver`.noThrow().text()).trim()
    const turnPort = freePort()
    // the relay must reach the bridge's host candidates, so it listens on a LAN address (loopback relays can't send to the LAN)
    const lanIp = Deno.networkInterfaces().find((entry) => entry.family === "IPv4" && !entry.address.startsWith("127.") && !entry.address.startsWith("169.254."))?.address ?? "127.0.0.1"
    const udpLow = 41000 + Math.floor(Math.random() * 2000)
    /** @type {string[]} */
    let iceArgs = ["--ice-server", `stun:${lanIp}:${turnPort}`, "--udp-ports", `${udpLow}-${udpLow + 4}`]
    if (turnserver) {
        const secret = "e2e-secret"
        // killed by finish(): a turnserver left behind keeps its ports and outlives the suite
        killOnCleanup($`${turnserver} -n --listening-ip=${lanIp} --relay-ip=${lanIp} --listening-port=${turnPort} --use-auth-secret --static-auth-secret=${secret} --realm=zenoh-web --no-tls --no-dtls --allow-loopback-peers --cli-port=${freePort()} --min-port=49200 --max-port=49300 --log-file=${scratch.join("turnserver.log")}`
            .stdout("null").stderr("null").noThrow().spawn())
        await $.sleep(1000)
        iceArgs = ["--ice-server", `turn:${lanIp}:${turnPort}?transport=udp`, "--turn-secret", secret, "--udp-ports", `${udpLow}-${udpLow + 4}`]
    } else {
        console.log("SKIP TURN relay: no turnserver (coturn) found; set TURNSERVER=<path>. Credential minting is covered by the unit tests.")
    }
    const iceBridge = await startBridge(scratch, peer.zenohPort, webRoot, iceArgs)
    await $.sleep(500)
    const ice = await page.evaluate(async (bridgeUrl, relayOnly) => {
        const { connect } = await import("/client/zenoh_web.js")
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const client = await connect(bridgeUrl, relayOnly ? { iceTransportPolicy: "relay" } : {}).catch((error) => error)
        if (client instanceof Error) {
            return { error: client.message, iceServers: [], bridgePorts: [] }
        }
        let received = 0
        const subscription = client.subscribe("test/open/data", {}, () => received++)
        await subscription.ready()
        await sleep(1000)
        const stats = [...(await client._peer.getStats()).values()]
        const pair = stats.find((entry) => entry.type === "candidate-pair" && entry.nominated && entry.state === "succeeded")
        const local = stats.find((entry) => entry.id === pair?.localCandidateId)
        const remoteSdp = client._peer.remoteDescription.sdp
        const bridgePorts = [...remoteSdp.matchAll(/a=candidate:\S+ \d+ udp \d+ \S+ (\d+) typ host/gi)].map((match) => Number(match[1]))
        client.close()
        return { iceServers: client.iceServers, received, localType: local?.candidateType, bridgeRelay: remoteSdp.includes("typ relay"), bridgePorts }
    }, { args: [iceBridge.url, Boolean(turnserver)] })
    console.log("ice:", JSON.stringify(ice))
    const url = ice.iceServers[0]?.urls?.[0] ?? ""
    check(url.endsWith(`${lanIp}:${turnPort}`) || url.includes(`${lanIp}:${turnPort}?`), `the client gets the bridge's ICE servers (${url})`)
    check(ice.bridgePorts.length > 0 && ice.bridgePorts.every((port) => port >= udpLow && port <= udpLow + 4), `the bridge's UDP candidates use --udp-ports ${udpLow}-${udpLow + 4} (${ice.bridgePorts})`)
    if (turnserver) {
        check(/^\d+:browser$/.test(ice.iceServers[0].username) && ice.iceServers[0].credential.length === 28, `the client gets minted TURN credentials (${ice.iceServers[0].username})`)
        check(ice.bridgeRelay, "the bridge gathers a relay candidate through the same TURN server with its own minted credentials")
        check(ice.localType === "relay" && ice.received > 5, `a relay-only connection works through coturn (local ${ice.localType}, ${ice.received} messages)`)
    }

    $.logStep("--ice-servers-command")
    const mintScript = scratch.join("mint_ice.sh")
    mintScript.writeTextSync(`[ "$ZENOH_WEB_ICE_TOKEN" = broken ] && exit 3\nprintf '{"iceServers":[{"urls":["turn:minted.example:3478"],"username":"%s","credential":"%s"}]}' "$ZENOH_WEB_ICE_SIDE" "$ZENOH_WEB_ICE_TOKEN"\n`)
    const commandBridge = await startBridge(scratch, peer.zenohPort, webRoot, ["--ice-server", "stun:static.example:3478", "--ice-servers-command", `sh ${mintScript}`])
    const iceFor = async (token) => (await (await fetch(`${commandBridge.url}/zenoh-web/ice`, { headers: { authorization: `Bearer ${token}` } })).json()).iceServers
    const minted = await iceFor("abc")
    check(minted.length === 2 && minted[0].urls[0] === "stun:static.example:3478" && minted[1].urls[0] === "turn:minted.example:3478" && minted[1].username === "browser" && minted[1].credential === "abc", `the command's servers follow --ice-server, with the side and token (${JSON.stringify(minted)})`)
    const fallback = await iceFor("broken")
    check(fallback.length === 1 && fallback[0].urls[0] === "stun:static.example:3478", `a failing command leaves only --ice-server (${JSON.stringify(fallback)})`)

    $.logStep("iceTransportPolicy from the ICE reply")
    const policies = await page.evaluate(async (bridgeUrl) => {
        const { connect } = await import("/client/zenoh_web.js")
        const realFetch = window.fetch
        const RealPeer = window.RTCPeerConnection
        const seen = []
        // a host app answering /zenoh-web/ice with a relay policy, as dimos-desktop does
        window.fetch = async (input, init) => {
            const response = await realFetch(input, init)
            if (!String(input).endsWith("/zenoh-web/ice")) {
                return response
            }
            return new Response(JSON.stringify({ ...(await response.json()), iceTransportPolicy: "relay" }), { headers: { "content-type": "application/json" } })
        }
        window.RTCPeerConnection = class extends RealPeer {
            constructor(config) {
                seen.push(config.iceTransportPolicy)
                super({ ...config, iceTransportPolicy: "all" })
            }
        }
        try {
            const fromReply = await connect(bridgeUrl, { reconnect: false, token: "policy" })
            fromReply.close()
            const callerWins = await connect(bridgeUrl, { reconnect: false, token: "policy", iceTransportPolicy: "all" })
            callerWins.close()
        } finally {
            window.fetch = realFetch
            window.RTCPeerConnection = RealPeer
        }
        return seen
    }, { args: [commandBridge.url] })
    check(policies.join() === "relay,all", `the reply's iceTransportPolicy applies unless connect() sets one (${policies})`)

    // real Cloudflare TURN: CF_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN (or CF_TURN_API_TOKEN)
    const cloudflareKey = Deno.env.get("CF_TURN_KEY_ID")
    const cloudflareToken = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN") ?? Deno.env.get("CF_TURN_API_TOKEN")
    if (cloudflareKey && cloudflareToken) {
        $.logStep("Cloudflare TURN, relay only")
        Deno.env.set("CLOUDFLARE_TURN_API_TOKEN", cloudflareToken)
        const cloudflareBridge = await startBridge(scratch, peer.zenohPort, webRoot, ["--cloudflare-turn-key-id", cloudflareKey, "--cloudflare-turn-ttl", "600"])
        await $.sleep(500)
        const relayed = await page.evaluate(async (bridgeUrl) => {
            const { connect } = await import("/client/zenoh_web.js")
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            const client = await connect(bridgeUrl, { iceTransportPolicy: "relay" }).catch((error) => error)
            if (client instanceof Error) {
                return { error: client.message, urls: [] }
            }
            let received = 0
            const subscription = client.subscribe("test/open/data", {}, () => received++)
            await subscription.ready()
            await sleep(2000)
            const stats = [...(await client._peer.getStats()).values()]
            const pair = stats.find((entry) => entry.type === "candidate-pair" && entry.nominated && entry.state === "succeeded")
            const local = stats.find((entry) => entry.id === pair?.localCandidateId)
            const urls = client.iceServers.flatMap((server) => server.urls)
            client.close()
            return { urls, received, localType: local?.candidateType, relayUrl: local?.url }
        }, { args: [cloudflareBridge.url] })
        console.log("cloudflare:", JSON.stringify({ ...relayed, urls: relayed.urls }))
        check(relayed.urls.some((url) => url.includes("turn.cloudflare.com")) && !relayed.urls.some((url) => url.split("?")[0].endsWith(":53")), `the client gets Cloudflare's TURN servers, port 53 dropped (${relayed.urls})`)
        check(relayed.localType === "relay" && relayed.received > 5, `a relay-only connection works through Cloudflare TURN (local ${relayed.localType}, ${relayed.received} messages, ${relayed.error ?? ""})`)
    } else {
        console.log("SKIP Cloudflare TURN: set CF_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN")
    }
} catch (error) {
    console.error(error)
    check(false, `suite threw: ${error}`)
}
await finish(scratch.toString())
