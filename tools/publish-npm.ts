// Publishes the npm packages (docs/publishing-plan.md §7; release.yml runs it). Packs them first (tools/pack.ts: exact
// versions, LICENSE and NOTICE, checked), then `npm publish` each tarball in dependency order, so a release that stops
// half way never leaves a package whose dependency isn't there yet. A version npm already has is skipped, so a failed
// release can simply run again.
//
//   bun run tools/publish-npm.ts --dry-run       pack, and `npm publish --dry-run` each (nothing uploaded)
//   bun run tools/publish-npm.ts                 publish (needs npm login, or NODE_AUTH_TOKEN in CI)
//   ... --provenance                             add npm's provenance (CI with id-token: write)
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { publishable } from "./pack"

const root = resolve(import.meta.dir, "..")
const { values } = parseArgs({
  options: { "dry-run": { type: "boolean" }, provenance: { type: "boolean" }, out: { type: "string" } },
})
const dry = values["dry-run"] ?? false
const out = resolve(values.out ?? join(root, "build/npm"))

function run(cmd: string[], quiet = false): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" })
  const text = p.stdout.toString() + p.stderr.toString()
  if (!quiet) process.stdout.write(text)
  return { code: p.exitCode ?? 1, out: text }
}

const packed = run(["bun", "run", "tools/pack.ts", "--out", out])
if (packed.code !== 0) process.exit(1)

let failed = false
for (const p of publishable()) {
  const tgz = join(out, `${p.name.replace(/^@/, "").replace("/", "-")}-${p.version}.tgz`)
  // npm view answers the version when it is published, nothing (and exit 1, E404) when it isn't.
  const seen = run(["npm", "view", `${p.name}@${p.version}`, "version"], true)
  if (seen.code === 0 && seen.out.trim() === p.version) {
    console.log(`= ${p.name}@${p.version} is on npm already: skipped`)
    continue
  }
  const cmd = ["npm", "publish", tgz, "--access", "public", ...(dry ? ["--dry-run"] : []), ...(values.provenance && !dry ? ["--provenance"] : [])]
  console.log(`${dry ? "(dry run) " : ""}npm publish ${p.name}@${p.version}`)
  const r = run(cmd, true)
  if (r.code !== 0) {
    console.error(r.out)
    failed = true
    break // the next packages may depend on this one
  }
}
process.exit(failed ? 1 : 0)
