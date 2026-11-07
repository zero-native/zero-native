// Readers for the two binary formats native gets: .zn.ui templates (format: packages/template/src/writer.ts) and
// batches (format: core/include/zn/batch.h). Ports of android/runtime's TemplateReader.kt and BatchReader.kt, with the
// same checks: an id this app doesn't know is refused when read, never drawn wrongly (docs/ota.md §3.2).
import Foundation

/// A value from a template or a batch. Batches carry only null, bool, number and string.
enum ZnValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    /// ARGB, parsed at build time.
    case color(UInt32)
    /// A size as a fraction of the parent ("50%" → 0.5).
    case percent(Double)
    /// A registry enum value.
    case enumValue(Int)

    var number: Double? { if case .number(let n) = self { return n } else { return nil } }
    var string: String? { if case .string(let s) = self { return s } else { return nil } }
    var bool: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    var isNull: Bool { self == .null }
}

struct ZnFormatError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

/// Little-endian reads over bytes, checked: running past the end is an error, not a crash.
struct ByteReader {
    let data: [UInt8]
    var pos = 0
    init(_ data: Data) { self.data = [UInt8](data) }

    var remaining: Int { data.count - pos }

    mutating func need(_ n: Int) throws {
        if n < 0 || pos + n > data.count { throw ZnFormatError("truncated at byte \(pos)") }
    }
    mutating func u8() throws -> Int {
        try need(1); defer { pos += 1 }
        return Int(data[pos])
    }
    mutating func u16() throws -> Int {
        try need(2); defer { pos += 2 }
        return Int(data[pos]) | Int(data[pos + 1]) << 8
    }
    mutating func u32() throws -> UInt32 {
        try need(4); defer { pos += 4 }
        return UInt32(data[pos]) | UInt32(data[pos + 1]) << 8 | UInt32(data[pos + 2]) << 16 | UInt32(data[pos + 3]) << 24
    }
    mutating func f64() throws -> Double {
        try need(8)
        var bits: UInt64 = 0
        for i in 0..<8 { bits |= UInt64(data[pos + i]) << (8 * UInt64(i)) }
        pos += 8
        return Double(bitPattern: bits)
    }
    mutating func utf8(_ n: Int) throws -> String {
        try need(n); defer { pos += n }
        return String(decoding: data[pos..<pos + n], as: UTF8.self)
    }
}

// MARK: - Templates

struct SlotDef {
    let node: Int
    let prop: Int
    let defaultValue: ZnValue
}

struct EventDef {
    let node: Int
    let kind: Int
    let eventId: Int
}

/// One template as read from the file: plain data, before preparation for drawing (ZnTemplate).
struct RawTemplate {
    let component: [Int]
    /// -1 for the root.
    let parent: [Int]
    let props: [[Int: ZnValue]]
    let slots: [SlotDef]
    let events: [EventDef]
}

struct TemplateFile {
    let registryVersion: Int
    let templates: [RawTemplate]
}

enum TemplateReader {
    static let magic: UInt32 = 0x4955_4E5A  // "ZNUI"
    static let formatVersion = 1
    static let rootParent = 0xFFFF

    /// Prop id → its value type (Registry.propTypes codes).
    private static let propTypes: [Int: Int] = Dictionary(uniqueKeysWithValues: zip(Registry.propIds, Registry.propTypes))

    private static func checkProp(_ whereText: String, _ prop: Int, _ value: ZnValue) throws {
        guard let type = propTypes[prop] else {
            throw ZnFormatError("\(whereText): unknown prop \(prop) (this app has registry v\(Registry.version))")
        }
        let fits: Bool
        if prop == Registry.Prop.value {
            switch value { case .null, .string, .bool, .number: fits = true; default: fits = false }
        } else {
            switch (type, value) {
            case (_, .null): fits = true
            case (0, .number), (1, .number), (1, .percent), (2, .string), (3, .color), (4, .enumValue), (5, .bool): fits = true
            default: fits = false
            }
        }
        if !fits { throw ZnFormatError("\(whereText): prop \(prop) can't hold \(value)") }
        if case .enumValue(let v) = value, !(Registry.enumValues[prop]?.contains(v) ?? false) {
            throw ZnFormatError("\(whereText): prop \(prop) has unknown value \(v)")
        }
    }

    static func read(_ data: Data) throws -> TemplateFile {
        var b = ByteReader(data)
        guard try b.u32() == magic else { throw ZnFormatError("not a .zn.ui template file") }
        let format = try b.u16()
        guard format == formatVersion else {
            throw ZnFormatError("template format \(format) is not supported (this runtime reads \(formatVersion))")
        }
        let registry = try b.u16()
        guard registry <= Registry.version else {
            throw ZnFormatError("template needs registry v\(registry), this app has v\(Registry.version) (ARCHITECTURE §16.2)")
        }
        let stringCount = Int(try b.u32())
        var strings: [String] = []
        strings.reserveCapacity(stringCount)
        for _ in 0..<stringCount { strings.append(try b.utf8(Int(try b.u32()))) }

        func value() throws -> ZnValue {
            switch try b.u8() {
            case 0: return .null
            case 1: return .bool(false)
            case 2: return .bool(true)
            case 3: return .number(try b.f64())
            case 4:
                let i = Int(try b.u32())
                guard i < strings.count else { throw ZnFormatError("string \(i) out of range") }
                return .string(strings[i])
            case 5: return .color(try b.u32())
            case 6: return .percent(try b.f64())
            case 7: return .enumValue(try b.u16())
            case let k: throw ZnFormatError("unknown template value kind \(k)")
            }
        }

        var templates: [RawTemplate] = []
        let templateCount = try b.u16()
        for _ in 0..<templateCount {
            let nodeCount = try b.u16()
            var component: [Int] = [], parent: [Int] = [], props: [[Int: ZnValue]] = []
            for n in 0..<nodeCount {
                let c = try b.u16()
                guard Registry.componentIds.contains(c) else {
                    throw ZnFormatError("node \(n): unknown component \(c) (this app has registry v\(Registry.version))")
                }
                let p = try b.u16()
                let par = p == rootParent ? -1 : p
                guard n == 0 || (0..<n).contains(par) else { throw ZnFormatError("node \(n): parent must come before its children") }
                var map: [Int: ZnValue] = [:]
                for _ in 0..<(try b.u8()) {
                    let prop = try b.u16()
                    let v = try value()
                    try checkProp("node \(n)", prop, v)
                    map[prop] = v
                }
                component.append(c); parent.append(par); props.append(map)
            }
            var slots: [SlotDef] = []
            for _ in 0..<(try b.u16()) {
                let s = SlotDef(node: try b.u16(), prop: try b.u16(), defaultValue: try value())
                try checkProp("slot on node \(s.node)", s.prop, s.defaultValue)
                guard Registry.dynamicPropIds.contains(s.prop) else {
                    throw ZnFormatError("slot on node \(s.node): prop \(s.prop) can't change at runtime in this app")
                }
                slots.append(s)
            }
            var events: [EventDef] = []
            for _ in 0..<(try b.u16()) {
                let e = EventDef(node: try b.u16(), kind: try b.u16(), eventId: try b.u16())
                guard Registry.eventIds.contains(e.kind) else {
                    throw ZnFormatError("node \(e.node): unknown event \(e.kind) (this app has registry v\(Registry.version))")
                }
                events.append(e)
            }
            templates.append(RawTemplate(component: component, parent: parent, props: props, slots: slots, events: events))
        }
        guard b.remaining == 0 else { throw ZnFormatError("template file has \(b.remaining) extra bytes") }
        return TemplateFile(registryVersion: registry, templates: templates)
    }
}

// MARK: - Batches

/// One UI change from JS (ARCHITECTURE.md §8.3).
enum BatchOp {
    case patch(instance: UInt32, slot: Int, value: ZnValue)
    case mount(templateId: Int, parent: UInt32, anchor: Int, instance: UInt32, index: Int, values: [ZnValue])
    case remove(instance: UInt32)
    case move(instance: UInt32, toIndex: Int)
    case nav(kind: Int, entry: UInt32, route: Int, params: String?)
    case listSet(instance: UInt32, node: Int, keys: [String], types: [Int])
    case listSplice(instance: UInt32, node: Int, index: Int, removeCount: Int, keys: [String], types: [Int])
    case listRow(instance: UInt32, node: Int, key: String, row: UInt32)
}

/// Kinds of NAV ops (core/include/zn/batch.h).
enum NavKind {
    static let push = 1, remove = 2, clear = 3, exit = 4, backAnswered = 5, impressions = 6, failed = 7, started = 8
    static let restore = 9, backWanted = 10, layer = 11
}

enum BatchReader {
    static let magic: UInt32 = 0x3142_4E5A  // "ZNB1"

    static func read(_ data: Data) throws -> [BatchOp] {
        var b = ByteReader(data)
        guard try b.u32() == magic else { throw ZnFormatError("not a zero-native batch") }
        let count = Int(try b.u32())

        func value() throws -> ZnValue {
            switch try b.u8() {
            case 0: return .null
            case 1: return .bool(false)
            case 2: return .bool(true)
            case 3: return .number(try b.f64())
            case 4: return .string(try b.utf8(Int(try b.u32())))
            case let k: throw ZnFormatError("unknown value kind \(k)")
            }
        }
        func key(_ v: ZnValue) -> String {
            switch v {
            case .string(let s): return s
            case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
            case .bool(let x): return String(x)
            default: return "null"
            }
        }
        func rows() throws -> ([String], [Int]) {
            let n = Int(try b.u32())
            var keys: [String] = [], types: [Int] = []
            for _ in 0..<n { keys.append(key(try value())); types.append(try b.u16()) }
            return (keys, types)
        }

        var ops: [BatchOp] = []
        ops.reserveCapacity(count)
        for _ in 0..<count {
            switch try b.u8() {
            case 1: ops.append(.patch(instance: try b.u32(), slot: try b.u16(), value: try value()))
            case 2:
                let templateId = try b.u16(), parent = try b.u32(), anchor = try b.u16()
                let instance = try b.u32(), index = Int(try b.u32())
                let n = try b.u16()
                var values: [ZnValue] = []
                for _ in 0..<n { values.append(try value()) }
                ops.append(.mount(templateId: templateId, parent: parent, anchor: anchor, instance: instance, index: index, values: values))
            case 3: ops.append(.remove(instance: try b.u32()))
            case 4: ops.append(.move(instance: try b.u32(), toIndex: Int(try b.u32())))
            case 5:
                let kind = try b.u8(), entry = try b.u32(), route = try b.u16()
                ops.append(.nav(kind: kind, entry: entry, route: route, params: try value().string))
            case 6:
                let instance = try b.u32(), node = try b.u16()
                let (keys, types) = try rows()
                ops.append(.listSet(instance: instance, node: node, keys: keys, types: types))
            case 7:
                let instance = try b.u32(), node = try b.u16(), index = Int(try b.u32()), removeCount = Int(try b.u32())
                let (keys, types) = try rows()
                ops.append(.listSplice(instance: instance, node: node, index: index, removeCount: removeCount, keys: keys, types: types))
            case 8:
                let instance = try b.u32(), node = try b.u16()
                let k = key(try value())
                ops.append(.listRow(instance: instance, node: node, key: k, row: try b.u32()))
            case let code: throw ZnFormatError("unknown batch op \(code)")
            }
        }
        guard b.remaining == 0 else { throw ZnFormatError("batch has \(b.remaining) extra bytes") }
        return ops
    }
}
