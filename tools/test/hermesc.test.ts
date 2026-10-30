import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hermesc } from "../hermesc"

test("the same JS gives the same bytecode in any folder (no build path inside; docs/ota.md §3.1, step 4.8)", async () => {
  const js = 'function f() { throw new Error("x") }\nf()\n'
  const out: Uint8Array[] = []
  for (const name of ["zn-hermesc-a-", "zn-hermesc-bb-"]) {
    const dir = mkdtempSync(join(tmpdir(), name))
    writeFileSync(join(dir, "main.js"), js)
    await hermesc(join(dir, "main.js"), join(dir, "main.hbc"))
    out.push(new Uint8Array(await Bun.file(join(dir, "main.hbc")).arrayBuffer()))
  }
  expect(Buffer.from(out[1]).equals(Buffer.from(out[0]))).toBe(true)
  expect(Buffer.from(out[0]).includes(Buffer.from("zn-hermesc"))).toBe(false)
})
