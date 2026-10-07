#!/usr/bin/env -S deno run --allow-all
// End-to-end: the rest of the zenoh API from a browser page (SPEC "The rest of the zenoh API"):
// put/delete with options, get with options, a queryable the page answers for a zenoh get,
// liveliness both ways, matching, session info, and sample kind/encoding/attachment on subscriptions.
// Usage: deno run --allow-all test/zenoh_api.js

import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { buildAll, check, finish, launchBrowser, machineLoad, startBridge, startPeer } from "./harness.js"

const scratch = $.path(await Deno.makeTempDir({ prefix: "zenoh-gateway-api-" }))
console.log(`machine load at start: ${await machineLoad()}`)

try {
    const webRoot = await buildAll(scratch)
    const peer = await startPeer([])
    const bridge = await startBridge(scratch, peer.zenohPort, webRoot)
    await $.sleep(1000)
    const browser = await launchBrowser()
    const page = await browser.newPage(`${bridge.url}/test/blank.html`)

    const out = await page.evaluate(async (bridgeUrl) => {
        const { connect } = await import("/client/zenoh_gateway.js")
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const text = (bytes) => bytes === undefined ? undefined : new TextDecoder().decode(bytes)
        const z = await connect(bridgeUrl)
        const out = {}

        // put / delete with options
        await z.put("test/api/in/a", "hello", { encoding: "text/plain", attachment: "browser-att", priority: 2, congestionControl: "block", express: true })
        await z.delete("test/api/in/a", { attachment: "bye" })
        const publisher = z.publisher("test/api/in/b", { delivery: "reliable" })
        await publisher.ready()
        await publisher.delete()

        // get with options; rich replies
        const replies = await z.get("test/api/echo/*", { parameters: "a=1", payload: "question", encoding: "text/plain", attachment: "ask-att", consolidation: "none", target: "all", timeoutMs: 2000 })
        out.replies = replies.map((reply) => ({ key: reply.key, bytes: text(reply.bytes), error: reply.error ?? false, kind: reply.kind, encoding: reply.encoding, attachment: text(reply.attachment) }))
        const querier = z.querier("test/api/echo/*", { consolidation: "none", timeoutMs: 2000 })
        out.querier = (await querier.get({ parameters: "b=2" })).map((reply) => text(reply.bytes))
        out.querierMatching = await querier.matchingStatus()

        // a queryable this page answers; the peer's get loop asks it
        const queries = []
        const queryable = await z.declareQueryable("test/api/browser/**", {}, (query) => {
            queries.push({ key: query.key, parameters: query.parameters, payload: text(query.payload) })
            query.reply("from-browser", { encoding: "text/plain" }).then(() => query.replyErr("browser-err")).then(() => query.finalize())
        })
        await sleep(1500)
        out.queries = queries.slice(0, 1)

        // liveliness: the page's token seen by zenoh; zenoh's token seen by the page
        const changes = []
        const watcher = await z.livelinessSubscribe("test/api/token/**", { history: true }, (change) => changes.push(change))
        const token = await z.declareToken("test/api/token/browser")
        await sleep(500)
        out.tokens = (await z.livelinessGet("test/api/token/**")).sort()
        await token.undeclare()
        await sleep(500)
        out.changes = changes
        await watcher.undeclare()

        // matching
        out.matchingNobody = await z.matchingStatus("test/api/nobody", "subscribers")
        out.matchingPeer = await z.matchingStatus("test/api/in/x", "subscribers")
        const matching = []
        const listener = await z.matchingListener("test/api/in/x", "subscribers", (value) => matching.push(value))
        await sleep(500)
        out.listenerFirst = matching[0]
        await listener.undeclare()

        // session info
        out.info = await z.info()

        // sample kind, encoding and attachment on a subscription
        const messages = []
        const subscription = z.subscribe("test/api/meta", { delivery: "reliable" }, (message) => messages.push({ kind: message.kind, bytes: text(message.bytes), encoding: message.encoding, attachment: text(message.attachment) }))
        await subscription.ready()
        await sleep(1500)
        out.messages = messages.slice(0, 4)
        subscription.close()
        await queryable.undeclare()
        z.close()
        return out
    }, { args: [bridge.url] })
    console.log(JSON.stringify(out, null, 2))
    await $.sleep(500)
    const apiLines = peer.output.lines.filter((line) => line.startsWith("API "))
    console.log(apiLines)
    check(apiLines.includes("API put test/api/in/a hello enc=text/plain att=browser-att"), "put arrives with its encoding and attachment")
    check(apiLines.includes("API delete test/api/in/a  enc=zenoh/bytes att=bye"), "delete arrives as a delete with its attachment")
    check(apiLines.some((line) => line.startsWith("API delete test/api/in/b")), "publisher.delete() deletes its key")

    const ok = out.replies.find((reply) => reply.key === "test/api/echo/x")
    check(ok?.bytes === "a=1|question|text/plain|ask-att" && ok.encoding === "text/plain" && ok.attachment === "reply-att", `get carries parameters, payload, encoding, attachment; the reply its encoding and attachment (${JSON.stringify(ok)})`)
    check(out.replies.some((reply) => reply.error && reply.bytes === "echo-err"), "an error reply arrives as an error")
    check(out.replies.some((reply) => reply.kind === "delete" && reply.key === "test/api/echo/gone"), "a delete reply arrives as a delete")
    check(out.querier.some((bytes) => bytes?.startsWith("b=2|")) && out.querierMatching === true, `a querier queries with its options (${out.querier}, matching ${out.querierMatching})`)

    check(out.queries[0]?.parameters === "from=peer" && out.queries[0]?.payload === "ask", `the page's queryable receives the peer's query (${JSON.stringify(out.queries)})`)
    const got = peer.output.lines.find((line) => line.startsWith("GOT "))
    const gotReplies = got?.slice(4).split(";").sort().join(";")
    check(gotReplies === "err=browser-err;test/api/browser/q=from-browser", `the peer's get receives the page's replies, in either order (${got})`)

    check(peer.output.lines.includes("ALIVE test/api/token/browser") && peer.output.lines.includes("GONE test/api/token/browser"), "zenoh sees the page's token come and go")
    check(out.tokens.join(",") === "test/api/token/browser,test/api/token/peer", `livelinessGet lists both tokens (${out.tokens})`)
    check(out.changes.some((change) => change.key === "test/api/token/peer" && change.alive), "the page sees zenoh's token (history)")

    check(out.matchingNobody === false && out.matchingPeer === true && out.listenerFirst === true, `matching status and listener (${out.matchingNobody}, ${out.matchingPeer}, ${out.listenerFirst})`)
    check(typeof out.info.zid === "string" && out.info.zid.length > 0 && out.info.peers.length >= 1, `session info: the gateway's zid and the peer (${JSON.stringify(out.info)})`)

    const put = out.messages.find((message) => message.kind === "put")
    const deleted = out.messages.find((message) => message.kind === "delete")
    check(put?.bytes === "meta-payload" && put.encoding === "application/json" && put.attachment === "peer-att", `subscription messages carry encoding and attachment (${JSON.stringify(put)})`)
    check(deleted !== undefined && deleted.bytes === "", `deletes arrive as kind "delete" (${JSON.stringify(deleted)})`)
} finally {
    await finish(scratch)
}
