// The Swift half of znstorage_tests.mm: ZnStorage.store (ios/ZnRuntime/Swift/ZnStorage.swift) over ZNStorage.
// Answers the number of failed checks; prints each failure.
import Foundation

private var failed: Int32 = 0

private func check(_ ok: Bool, _ what: String, line: Int = #line) {
    if !ok {
        failed += 1
        print("  FAIL znstorage_swift_check.swift:\(line)  \(what)")
    }
}

@_cdecl("zn_storage_swift_check")
public func znStorageSwiftCheck() -> Int32 {
    let s = ZnStorage.store()
    check(s.id == "zn.default", "the default store is JS's storage")

    // Every type, with its type back.
    s.set("swift.s", "héllo")
    s.set("swift.n", 42)
    s.set("swift.d", 0.25)
    s.set("swift.on", true)
    s.set("swift.b", Data([1, 2, 3]))
    check(s.string("swift.s") == "héllo", "string")
    check(s.number("swift.n") == 42, "an Int is a number")
    check(s.number("swift.d") == 0.25, "double")
    check(s.bool("swift.on") == true, "bool")
    check(s.bytes("swift.b") == Data([1, 2, 3]), "bytes")
    check(s.get("swift.s") == .string("héllo"), "get string")
    check(s.get("swift.n") == .number(42), "get number")
    check(s.get("swift.on") == .boolean(true), "get boolean")
    check(s.get("swift.b") == .bytes(Data([1, 2, 3])), "get bytes")
    check(s.get("swift.missing") == nil, "get missing")

    // Another type answers nil: a boolean isn't a number, a number isn't a boolean (NSNumber would say yes to both).
    check(s.number("swift.on") == nil, "bool as number")
    check(s.bool("swift.n") == nil, "number as bool")
    check(s.string("swift.b") == nil, "bytes as string")
    check(s.bytes("swift.s") == nil, "string as bytes")

    // A value set through the enum, has, delete, keys, clear on its own store.
    let other = ZnStorage.store("swift.other")
    other.clear()
    check(other.set("v", ZnStoredValue.boolean(false)), "set an enum value")
    check(other.get("v") == .boolean(false), "false is kept, not missing")
    other.set("w", "x")
    check(other.has("v") && !other.has("nope"), "has")
    check(other.keys().sorted() == ["v", "w"], "keys")
    check(other.delete("v") && !other.has("v"), "delete")
    other.flush()
    other.clear()
    check(other.keys().isEmpty, "clear")
    check(s.has("swift.s"), "clear touches one store only")

    // The id rule (a file name) and an empty key.
    check(ZnStorage.validId("zn.default") && ZnStorage.validId("user_42-settings"), "good ids")
    check(!ZnStorage.validId("") && !ZnStorage.validId("../x") && !ZnStorage.validId("a/b") && !ZnStorage.validId("é"), "bad ids")
    check(!ZnStorage.validId(String(repeating: "a", count: 65)) && ZnStorage.validId(String(repeating: "a", count: 64)), "64 at most")
    check(!s.set("", "v"), "an empty key isn't saved")
    return failed
}
