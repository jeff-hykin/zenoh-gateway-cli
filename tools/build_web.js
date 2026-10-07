#!/usr/bin/env -S deno run --allow-all
// Builds a servable web root: zenoh-gateway's client at the revision Cargo.lock pins, bundled to
// client/zenoh_gateway.js (esbuild via `deno bundle`, the same transform esm.sh applies to the .ts), plus
// the examples/web and test/ pages.
// Usage: deno run --allow-all tools/build_web.js [outDir]   (default: build)

import { $ } from "https://esm.sh/dax-sh@0.42.0"

export const repoRoot = $.path(import.meta.url).parentOrThrow().parentOrThrow()

/** The checkout of each crate cargo builds (git dependency or local patch): zenoh-gateway's repo root, the codecs' crate. */
/**
 * Checkouts of zenoh-gateway (its client and SPEC) and zenoh-dimos-codecs (its test fixtures): what cargo
 * builds against when that is a checkout (a path or git dependency); else ZENOH_GATEWAY_DIR /
 * ZENOH_DIMOS_CODECS_DIR, a sibling checkout (../zenoh-gateway, ../zenoh-web, ../zenoh-dimos-codecs), or a
 * shallow clone in ~/.cache/zenoh-gateway-cli. Published crates leave the client and the fixtures out.
 */
export async function crateRoots() {
    const metadata = JSON.parse(await $`cargo metadata --format-version 1`.cwd(repoRoot).text())
    /** @param {string} name */
    const crateDir = (name) => $.path(metadata.packages.find((/** @type {{ name: string }} */ crate) => crate.name === name).manifest_path).parentOrThrow()
    const fromRegistry = (/** @type {import("https://esm.sh/dax-sh@0.42.0").Path} */ dir) => dir.toString().includes("/.cargo/registry/")
    /**
     * @param {string} envVar
     * @param {string[]} siblings
     * @param {string} repository
     * @param {(dir: import("https://esm.sh/dax-sh@0.42.0").Path) => boolean} isCheckout
     */
    const checkout = async (envVar, siblings, repository, isCheckout) => {
        const fromEnv = Deno.env.get(envVar)
        if (fromEnv) {
            return $.path(fromEnv).resolve()
        }
        for (const sibling of siblings) {
            const dir = repoRoot.parentOrThrow().join(sibling)
            if (isCheckout(dir)) {
                return dir
            }
        }
        const cache = $.path(Deno.env.get("HOME") ?? ".").join(".cache/zenoh-gateway-cli", repository)
        if (!isCheckout(cache)) {
            await $`git clone --depth 1 https://github.com/jeff-hykin/${repository} ${cache}`
        }
        return cache
    }
    let zenohGateway = crateDir("zenoh-gateway").parentOrThrow()
    if (fromRegistry(zenohGateway)) {
        zenohGateway = await checkout("ZENOH_GATEWAY_DIR", ["zenoh-gateway", "zenoh-web"], "zenoh-gateway", (dir) => dir.join("client/zenoh_gateway.ts").existsSync())
    }
    let codecs = crateDir("zenoh-dimos-codecs")
    if (fromRegistry(codecs)) {
        codecs = await checkout("ZENOH_DIMOS_CODECS_DIR", ["zenoh-dimos-codecs"], "zenoh-dimos-codecs", (dir) => dir.join("test/fixtures").existsSync())
    }
    return { zenohGateway, codecs }
}

/** @param {string} outDir */
export async function buildWeb(outDir) {
    const out = $.path(outDir).resolve()
    out.join("client").mkdirSync({ recursive: true })
    const { zenohGateway } = await crateRoots()
    // Deno.Command, not dax: inside dax `deno bundle` resolved to `deno run bundle`
    const bundle = new Deno.Command(Deno.execPath(), {
        args: ["bundle", "--quiet", "--platform", "browser", "-o", out.join("client/zenoh_gateway.js").toString(), zenohGateway.join("client/zenoh_gateway.ts").toString()],
        stdout: "inherit",
        stderr: "inherit",
    })
    const { code } = await bundle.output()
    if (code !== 0) {
        throw new Error(`deno bundle failed with exit code ${code}`)
    }
    await $`cp -R ${repoRoot.join("examples/web")} ${out.join("examples")}`
    await $`cp -R ${repoRoot.join("test")} ${out}/`
    return out
}

if (import.meta.main) {
    const out = await buildWeb(Deno.args[0] ?? repoRoot.join("build").toString())
    console.log(`built ${out}; serve it with: zenoh-gateway --serve ${out}`)
}
