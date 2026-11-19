// `zn://` handles (ARCHITECTURE §15.4, as android/runtime's ZnHandles.kt): native files reach JS as a short string, never
// as bytes or paths. A plugin writes into `fileDir` and gives JS `zn://file/<name>`; a plugin that gets a handle back turns
// it into its file with `fileOf`. Only plain names directly in that folder get a handle, so a bundle (which can come over
// the air) can't make a plugin read a path of its choice.
import Foundation

public enum ZnHandles {
    private static let fileKind = "file"

    /// Where plugins write files that JS will name (a downloaded PDF, a scanned page). It stays after a kill; iOS may clear
    /// Caches when the phone is short of space, so a plugin must handle a handle whose file is gone.
    public static var fileDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("zn-files", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// `zn://file/<name>` for a file in `fileDir`, or nil (a mistake in the plugin: any other file gets no handle).
    public static func file(_ url: URL) -> String? {
        let name = url.lastPathComponent
        guard url.deletingLastPathComponent().standardizedFileURL.path == fileDir.standardizedFileURL.path,
              fileName(name) != nil else {
            assertionFailure("\(name) must be a plain file name inside ZnHandles.fileDir")
            return nil
        }
        return "zn://file/\(name)"
    }

    /// The file of a `zn://file/<name>` handle, if it is one and the file is there.
    public static func fileOf(_ handle: String) -> URL? {
        guard let (kind, path) = parse(handle), kind == fileKind, let name = fileName(path) else { return nil }
        let url = fileDir.appendingPathComponent(name)
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &dir) && !dir.boolValue ? url : nil
    }

    /// `name` if it can only mean a file directly in `fileDir`: no folders, no "..", no leading dot.
    static func fileName(_ name: String) -> String? {
        name.range(of: "^[A-Za-z0-9_-][A-Za-z0-9._-]*$", options: .regularExpression) != nil ? name : nil
    }

    /// `zn://kind/path` → (kind, path), or nil.
    static func parse(_ uri: String) -> (String, String)? {
        guard uri.hasPrefix("zn://") else { return nil }
        let rest = uri.dropFirst(5)
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let kind = String(rest[..<slash]), path = String(rest[rest.index(after: slash)...])
        return kind.isEmpty || path.isEmpty ? nil : (kind, path)
    }
}
