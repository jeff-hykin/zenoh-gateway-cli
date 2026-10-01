#!/usr/bin/env -S deno run --allow-all
// Builds a servable web root: zenoh-web's client plus zenoh-dimos-codecs' decoders (registered), at
// the revisions Cargo.lock pins, bundled to client/zenoh_web.js (esbuild via `deno bundle`, the same
// transform esm.sh applies to the .ts), plus the examples/web and test/ pages.
// Usage: deno run --allow-all tools/build_web.js [outDir]   (default: build)

import { $ } from "https://esm.sh/dax-sh@0.42.0"

export const repoRoot = $.path(import.meta.url).parentOrThrow().parentOrThrow()

/** The checkout of each crate cargo builds (git dependency or local patch), up to its repo root. */
export async function crateRoots() {
    const metadata = JSON.parse(await $`cargo metadata --format-version 1`.cwd(repoRoot).text())
    /** @param {string} name */
    const rootOf = (name) => {
        let dir = $.path(metadata.packages.find((/** @type {{ name: string }} */ crate) => crate.name === name).manifest_path).parentOrThrow()
        while (!dir.join("client").existsSync()) {
            dir = dir.parentOrThrow()
        }
        return dir
    }
    return { zenohWeb: rootOf("zenoh-web"), codecs: rootOf("zenoh-dimos-codecs") }
}

/** @param {string} outDir */
export async function buildWeb(outDir) {
    const out = $.path(outDir).resolve()
    out.join("client").mkdirSync({ recursive: true })
    const { zenohWeb, codecs } = await crateRoots()
    const entry = out.join("client/entry.ts")
    entry.writeTextSync([
        `import { registerCodec } from "${zenohWeb.join("client/zenoh_web.ts")}"`,
        `import { registerDimosCodecs } from "${codecs.join("client/dimos_codecs.ts")}"`,
        `export * from "${zenohWeb.join("client/zenoh_web.ts")}"`,
        `export * from "${codecs.join("client/dimos_codecs.ts")}"`,
        "registerDimosCodecs(registerCodec)",
    ].join("\n"))
    // Deno.Command, not dax: inside dax `deno bundle` resolved to `deno run bundle`
    const bundle = new Deno.Command(Deno.execPath(), {
        args: ["bundle", "--quiet", "--platform", "browser", "-o", out.join("client/zenoh_web.js").toString(), entry.toString()],
        stdout: "inherit",
        stderr: "inherit",
    })
    const { code } = await bundle.output()
    if (code !== 0) {
        throw new Error(`deno bundle failed with exit code ${code}`)
    }
    entry.removeSync()
    await $`cp -R ${repoRoot.join("examples/web")} ${out.join("examples")}`
    await $`cp -R ${repoRoot.join("test")} ${out}/`
    return out
}

if (import.meta.main) {
    const out = await buildWeb(Deno.args[0] ?? repoRoot.join("build").toString())
    console.log(`built ${out}; serve it with: zenoh-web --serve ${out}`)
}
