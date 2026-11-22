// `zn dev`'s wire format and build folders on the Mac (tools/ios-unit-test.ts builds this with ZnDevWire.swift). The
// frames are made here byte by byte as tools/zn-dev.ts's frame() and buildFrame() make them.
// Argument: a scratch folder.
import Foundation

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

let work = URL(fileURLWithPath: CommandLine.arguments[1])

/// u32 big endian.
func be32(_ n: Int) -> [UInt8] { [UInt8(n >> 24 & 0xFF), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)] }

/// As zn-dev.ts buildFrame's body: u32 header length, the header JSON, templates, manifest, hbc.
func buildBody(hash: String, templates: [UInt8], manifest: String, hbc: [UInt8], headerHbc: Int? = nil) -> Data {
    let m = Array(manifest.utf8)
    let header = Array("{\"asset\":\"main.zn.ui\",\"hash\":\"\(hash)\",\"templates\":\(templates.count),\"manifest\":\(m.count),\"hbc\":\(headerHbc ?? hbc.count)}".utf8)
    return Data(be32(header.count) + header + templates + m + hbc)
}

// frame(): length counts the type byte; big endian; then the type and the body.
do {
    let f = ZnDevWire.frame(ZnDevWire.hello, Data("{}".utf8))
    check("frame bytes", [UInt8](f), [0, 0, 0, 3, 10, UInt8(ascii: "{"), UInt8(ascii: "}")])
    let big = ZnDevWire.frame(ZnDevWire.build, Data(count: 0x01_02_03))
    check("big length", [UInt8](big.prefix(5)), [0x00, 0x01, 0x02, 0x04, 1])
    check("big size", big.count, 5 + 0x01_02_03)
    let json = ZnDevWire.frame(ZnDevWire.error, json: ["id": 3, "text": "a\nb"])
    let body = json.dropFirst(5)
    let o = try! JSONSerialization.jsonObject(with: Data(body)) as! [String: Any]
    check("json frame type", json[json.startIndex + 4], ZnDevWire.error)
    check("json frame id", o["id"] as? Int, 3)
    check("json frame text", o["text"] as? String, "a\nb")
    check("type numbers", [ZnDevWire.build, ZnDevWire.buildFailed, ZnDevWire.errorMapped, ZnDevWire.hello, ZnDevWire.error,
                           ZnDevWire.reload], [1, 2, 3, 10, 11, 12])
}

// head(): the body's length without the type byte; nil for a short head, length 0 or one too big.
do {
    let h = ZnDevWire.head(Data([0, 0, 1, 0, 2]))
    check("head body", h?.body, 255)
    check("head type", h?.type, 2)
    check("type only", ZnDevWire.head(Data([0, 0, 0, 1, 12]))?.body, 0)
    check("length 0", ZnDevWire.head(Data([0, 0, 0, 0, 1])) == nil, true)
    check("too big", ZnDevWire.head(Data([0x7F, 0, 0, 0, 1])) == nil, true)
    check("short", ZnDevWire.head(Data([0, 0, 1])) == nil, true)
}

// parseBuild(): the parts in order; a body whose size doesn't match its header is refused.
do {
    let body = buildBody(hash: "ab12", templates: [1, 2, 3], manifest: "{\"routes\":[]}", hbc: [0xC6, 0x1F, 9])
    let b = try! ZnDevWire.parseBuild(body)
    check("asset", b.asset, "main.zn.ui")
    check("hash", b.hash, "ab12")
    check("templates", [UInt8](b.templates), [1, 2, 3])
    check("manifest", String(decoding: b.manifest, as: UTF8.self), "{\"routes\":[]}")
    check("hbc", [UInt8](b.hbc), [0xC6, 0x1F, 9])
    let cut = buildBody(hash: "ab12", templates: [1], manifest: "{}", hbc: [1, 2], headerHbc: 5)
    check("cut build refused", (try? ZnDevWire.parseBuild(cut)) == nil, true)
    check("no header refused", (try? ZnDevWire.parseBuild(Data([0, 0, 0, 50, 1]))) == nil, true)
    check("bad json refused", (try? ZnDevWire.parseBuild(Data(be32(2) + Array("{]".utf8)))) == nil, true)
    check("empty refused", (try? ZnDevWire.parseBuild(Data())) == nil, true)
}

// folderName(): a hash names a folder only when it is hex (no "..", no slashes).
do {
    check("sha1", ZnDevWire.folderName("0123456789abcdef0123456789abcdef01234567"), "0123456789abcdef0123456789abcdef01234567")
    check("dots", ZnDevWire.folderName("../x"), nil)
    check("slash", ZnDevWire.folderName("ab/cd"), nil)
    check("empty", ZnDevWire.folderName(""), nil)
}

// write(): the three files ZnApp reads, in root/<hash>; older builds go, the running one stays; no .tmp is left.
do {
    let root = work.appendingPathComponent("zn-dev")
    let fm = FileManager.default
    func build(_ hash: String, _ hbc: UInt8) -> ZnDevWire.Build {
        try! ZnDevWire.parseBuild(buildBody(hash: hash, templates: [7], manifest: "{\"routes\":[]}", hbc: [hbc]))
    }
    let a = try! ZnDevWire.write(build("aaaa", 1), in: root, keep: nil)
    check("folder", a.lastPathComponent, "aaaa")
    check("templates file", (try? Data(contentsOf: a.appendingPathComponent("main.zn.ui"))).map { [UInt8]($0) }, [7])
    check("manifest file", fm.fileExists(atPath: a.appendingPathComponent("main.zn.ui.json").path), true)
    check("hbc file", (try? Data(contentsOf: a.appendingPathComponent("main.hbc"))).map { [UInt8]($0) }, [1])
    let b = try! ZnDevWire.write(build("bbbb", 2), in: root, keep: a)
    check("running kept", Set(try! fm.contentsOfDirectory(atPath: root.path)), ["aaaa", "bbbb"])
    _ = try! ZnDevWire.write(build("cccc", 3), in: root, keep: b)
    check("older one gone", Set(try! fm.contentsOfDirectory(atPath: root.path)), ["bbbb", "cccc"])
    // The same hash again (Reload): replaced, not doubled.
    let c2 = try! ZnDevWire.write(build("cccc", 4), in: root, keep: b)
    check("same hash replaced", (try? Data(contentsOf: c2.appendingPathComponent("main.hbc"))).map { [UInt8]($0) }, [4])
    check("no tmp left", (try! fm.contentsOfDirectory(atPath: root.path)).contains { $0.hasSuffix(".tmp") }, false)
    check("bad hash refused", (try? ZnDevWire.write(build("../evil", 5), in: root, keep: nil)) == nil, true)
}

print(failures == 0 ? "ios dev wire: \(count) checks passed" : "ios dev wire: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
