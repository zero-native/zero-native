// Checks on the Swift package's files that no CMake build would catch (Package.swift).
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const mmkv = join(import.meta.dir, "../../core/third_party/mmkv")

test("the Swift package's MMKV headers are the same as MMKV's own (core/third_party/mmkv/spm-include)", () => {
  const copies = readdirSync(join(mmkv, "spm-include/MMKV")).sort()
  // The 5 that MMKV's CMake copies into Core/include/MMKV (copy_files in Core/CMakeLists.txt)
  expect(copies).toEqual(["MMBuffer.h", "MMKV.h", "MMKVHandler.h", "MMKVPredef.h", "MiniPBCoder.h"])
  for (const f of copies) {
    expect({ f, same: readFileSync(join(mmkv, "spm-include/MMKV", f), "utf8") === readFileSync(join(mmkv, "Core", f), "utf8") }).toEqual({ f, same: true })
  }
})
