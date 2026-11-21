// App storage for Swift code (docs/storage.md), as Android's ZnStorage.store(context, id): the same stores and value
// format JS uses (`storage`, `createStorage(id)`), over ZNStorage (ZNHost.mm). A value comes back with the type it was
// saved with; a typed getter of another type answers nil (Android's throws), get(key) tells which type it is.
//
//   let s = ZnStorage.store()            // "zn.default", JS's `storage`
//   s.set("onboarded", true)             // JS: storage.getBoolean("onboarded") == true
//   let n = ZnStorage.store("cart").number("count") ?? 0
//
// Main thread only, as ZNStorage.
import Foundation
#if SWIFT_PACKAGE
import ZnHost
#endif

/// A stored value with its type (core/include/zn/storage.h StoredType).
public enum ZnStoredValue: Equatable {
    case string(String)
    case number(Double)
    case boolean(Bool)
    case bytes(Data)
}

public enum ZnStorage {
    /// JS's `storage` (core storage.ts DEFAULT_ID).
    public static let defaultId = "zn.default"

    /// A store by id (1-64 characters from A-Z a-z 0-9 . _ -; another id is a programming error, as on Android).
    public static func store(_ id: String = defaultId) -> Store {
        precondition(validId(id), "ZnStorage: id \"\(id)\" must be 1-64 characters from A-Z a-z 0-9 . _ -")
        return Store(id: id)
    }

    /// The store id rule of zn::Storage::validId (it becomes a file name).
    public static func validId(_ id: String) -> Bool {
        let utf8 = Array(id.utf8)
        guard !utf8.isEmpty, utf8.count <= 64 else { return false }
        return utf8.allSatisfy { c in
            (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39) || c == 0x2E || c == 0x5F || c == 0x2D
        }
    }

    public struct Store {
        public let id: String

        /// Each set answers false if it couldn't save (an empty key, or the store couldn't open; logged).
        @discardableResult public func set(_ key: String, _ value: String) -> Bool { ZNStorage.set(id, key: key, string: value) }
        @discardableResult public func set(_ key: String, _ value: Double) -> Bool { ZNStorage.set(id, key: key, number: value) }
        /// Saved as a JS number (a double): exact up to 2^53.
        @discardableResult public func set(_ key: String, _ value: Int) -> Bool { ZNStorage.set(id, key: key, number: Double(value)) }
        @discardableResult public func set(_ key: String, _ value: Bool) -> Bool { ZNStorage.set(id, key: key, boolean: value) }
        @discardableResult public func set(_ key: String, _ value: Data) -> Bool { ZNStorage.set(id, key: key, data: value) }
        @discardableResult public func set(_ key: String, _ value: ZnStoredValue) -> Bool {
            switch value {
            case .string(let v): return set(key, v)
            case .number(let v): return set(key, v)
            case .boolean(let v): return set(key, v)
            case .bytes(let v): return set(key, v)
            }
        }

        /// The value with its saved type, or nil if the key is missing (or holds data in a format JS doesn't write).
        public func get(_ key: String) -> ZnStoredValue? {
            switch ZNStorage.storedType(id, key: key) {
            case .string: return string(key).map(ZnStoredValue.string)
            case .number: return number(key).map(ZnStoredValue.number)
            case .boolean: return bool(key).map(ZnStoredValue.boolean)
            case .bytes: return bytes(key).map(ZnStoredValue.bytes)
            default: return nil
            }
        }

        public func string(_ key: String) -> String? { ZNStorage.string(id, key: key) }
        public func number(_ key: String) -> Double? { ZNStorage.number(id, key: key)?.doubleValue }
        public func bool(_ key: String) -> Bool? { ZNStorage.boolean(id, key: key)?.boolValue }
        public func bytes(_ key: String) -> Data? { ZNStorage.data(id, key: key) }

        public func has(_ key: String) -> Bool { ZNStorage.has(id, key: key) }
        @discardableResult public func delete(_ key: String) -> Bool { ZNStorage.remove(id, key: key) }
        public func keys() -> [String] { ZNStorage.keys(id) }
        public func clear() { ZNStorage.clear(id) }
        /// Forces the store to flash (~1 ms): survives a power cut, not just a killed app.
        public func flush() { ZNStorage.flush(id) }
    }
}
