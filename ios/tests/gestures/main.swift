import Foundation
struct ZnInvalidArgs: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
print("gestures: ok")
