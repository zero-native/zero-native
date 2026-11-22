// Applies a ZNBSDIFF1 patch on iOS (docs/ota-patches.md §2): a copy of android/runtime ZnBsPatch.kt, the phone side
// of tools/ota/bsdiff.ts, whose `applyPatch` is the reference. Foundation only, so ios/tests/ota checks it on the Mac
// against patches the TS code made.
//
// Format, all numbers 8-byte little endian, signed:
//
//     0   "ZNBSDIF1"                      magic
//     8   newSize                         size of the file it makes
//     16  controls                        number of (add, copy, seek) triples
//     24  controls × (add, copy, seek)
//     ..  diff bytes (sum of add), then extra bytes (sum of copy)
//
// For each triple: `add` bytes of `diff[i] + old[oldPos + i]` (old byte 0 outside the old file), then `copy` bytes from
// extra, then `oldPos += seek`.
//
// A patch is not trusted: every number is checked against newSize, the patch's own size and the counts before it is
// used. Swift stops the app on an integer overflow, so every sum that a patch's numbers feed is checked first: a bad
// patch can only fail, never crash. The caller still checks the result's size and SHA-256 against the signed bundle
// list (ZnOtaInstall.buildFromPatch).
import Foundation

enum ZnBsPatch {
    /// The format name in the check request (`patches`), the answer and `zn-patch.json`.
    static let format = "znbsdiff1"
    private static let magic = Array("ZNBSDIF1".utf8)
    private static let header = 24
    private static let control = 24
    /// The biggest file made, as Android's (a ByteArray's limit there), so both phones refuse the same patches.
    private static let maxFile = Int64(Int32.max) - 16

    /// Makes the new file from [old] and [patch]. The patch must make exactly [expectSize] bytes (the file's listed
    /// size). Throws ZnOtaError with code "patch" on any problem.
    static func apply(old: Data, patch: Data, expectSize: Int64) throws -> Data {
        try old.withUnsafeBytes { o in try patch.withUnsafeBytes { p in try apply(o, p, expectSize) } }
    }

    private static func apply(_ old: UnsafeRawBufferPointer, _ patch: UnsafeRawBufferPointer, _ expectSize: Int64) throws -> Data {
        let size = Int64(patch.count)
        guard patch.count >= header, (0..<8).allSatisfy({ patch[$0] == magic[$0] }) else { throw bad("not a ZNBSDIFF1 patch") }
        let newSize = long(patch, 8)
        let controls = long(patch, 16)
        if newSize < 0 || newSize != expectSize { throw bad("the patch makes \(newSize) bytes, expected \(expectSize)") }
        if newSize > maxFile { throw bad("the patch makes \(newSize) bytes, too big") }
        // Each control needs 24 bytes of the patch, so this also keeps controls × 24 small.
        if controls < 0 || controls > (size - Int64(header)) / Int64(control) { throw bad("bad control count \(controls)") }
        let count = Int(controls)
        let diffStart = Int64(header + count * control)

        // The diff part is the sum of every add. Checked one add at a time, so the sum can't overflow.
        var addTotal: Int64 = 0
        for c in 0..<count {
            let add = long(patch, header + c * control)
            if add < 0 || add > size - diffStart - addTotal { throw bad("bad diff length") }
            addTotal += add
        }

        var out = Data(count: Int(newSize))
        let made: Int64 = try out.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
            let oldCount = Int64(old.count)
            var diffAt = diffStart
            var extraAt = diffStart + addTotal
            var newPos: Int64 = 0
            var oldPos: Int64 = 0
            for c in 0..<count {
                let at = header + c * control
                let add = long(patch, at)
                let copy = long(patch, at + 8)
                let seek = long(patch, at + 16)
                if add < 0 || copy < 0 || add > newSize - newPos || copy > newSize - newPos - add {
                    throw bad("a control goes past the new size")
                }
                if add > size - diffAt || copy > size - extraAt { throw bad("a control goes past the patch") }
                let end = try plus(oldPos, add)  // oldPos + i below can't overflow now
                if add > 0 {
                    // The diff bytes, then the old bytes added where the old file has them (0 elsewhere).
                    let to = dst.baseAddress!.advanced(by: Int(newPos)).assumingMemoryBound(to: UInt8.self)
                    to.update(from: patch.baseAddress!.advanced(by: Int(diffAt)).assumingMemoryBound(to: UInt8.self), count: Int(add))
                    let lo = max(oldPos, 0)
                    let hi = min(end, oldCount)
                    if lo < hi {
                        let from = old.baseAddress!.advanced(by: Int(lo)).assumingMemoryBound(to: UInt8.self)
                        let into = to.advanced(by: Int(lo - oldPos))
                        for i in 0..<Int(hi - lo) { into[i] = into[i] &+ from[i] }
                    }
                }
                diffAt += add
                newPos += add
                oldPos = end
                if copy > 0 {
                    dst.baseAddress!.advanced(by: Int(newPos))
                        .copyMemory(from: patch.baseAddress!.advanced(by: Int(extraAt)), byteCount: Int(copy))
                }
                extraAt += copy
                newPos += copy
                oldPos = try plus(oldPos, seek)
            }
            return newPos
        }
        if made != newSize { throw bad("the patch made \(made) of \(newSize) bytes") }
        // Bytes after the extra part are not read, as in bsdiff.ts (patches made before 2026-11-09 have 8 zero bytes there).
        return out
    }

    /// The signed 8-byte little-endian number at [at] (the caller checked that the 8 bytes are there).
    private static func long(_ b: UnsafeRawBufferPointer, _ at: Int) -> Int64 {
        var v: UInt64 = 0
        for i in (0..<8).reversed() { v = v << 8 | UInt64(b[at + i]) }
        return Int64(bitPattern: v)
    }

    /// [a] + [b], refused when it doesn't fit in an Int64 (a seek made to overflow the old position).
    private static func plus(_ a: Int64, _ b: Int64) throws -> Int64 {
        let (sum, over) = a.addingReportingOverflow(b)
        if over { throw bad("the old position goes out of range") }
        return sum
    }

    private static func bad(_ why: String) -> ZnOtaError { ZnOtaError("patch", why) }
}
