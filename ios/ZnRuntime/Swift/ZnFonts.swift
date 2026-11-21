// The app's fonts for the running bundle (registry 24, RN fontFamily), as android/runtime's ZnFontTable (ZnFonts.kt):
// the manifest's "fonts" table, family name → faces ({ file, weight, italic }), written by compiler/src/fonts.ts.
//
// A stub for now: it keeps the table and resolves every family to the system font. One table per started bundle, set
// by ZnApp's start and restart (not yet), so an update applied while the app runs never mixes two bundles' fonts. A
// global rather than a field of ZnContext, so the font work doesn't touch the renderer's hot files.
import Foundation

@MainActor
final class ZnFontTable {
    /// The table of the running bundle (empty until a bundle installs one).
    private(set) static var current = ZnFontTable(fonts: [:])

    /// Sets [current] from a bundle's main.zn.ui.json (parsed); no "fonts" means no app fonts.
    static func install(manifest: [String: Any]?) {
        current = ZnFontTable(fonts: manifest?["fonts"] as? [String: Any] ?? [:])
    }

    /// The manifest's "fonts" as read (family name → its faces' JSON).
    let fonts: [String: Any]

    init(fonts: [String: Any]) { self.fonts = fonts }

    /// The family names this bundle ships.
    var families: [String] { fonts.keys.sorted() }
}
