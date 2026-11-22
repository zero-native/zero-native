// The app's fonts for the running bundle (registry 24, RN fontFamily), as android/runtime's ZnFontTable (ZnFonts.kt):
// the manifest's "fonts" table, family name → faces ({ file, weight, italic }), written by compiler/src/fonts.ts. A
// family's faces are picked per text by fontWeight and fontStyle, the closest weight as CSS (ZnFontRules.pick).
//
// Font files are bundle files like `asset:` images: the running OTA bundle's copy when it lists the file, else the
// app's (ZnBundles.assetURL). One table per started bundle, set by ZnApp.start (a restart starts again), so an update
// applied while the app runs never mixes two bundles' fonts. The fonts are made from the file's data
// (CTFontCreateWithGraphicsFont) and never registered with the system, so two bundles' files with the same PostScript
// name can't clash. A global rather than a field of ZnContext, so the font work doesn't touch the renderer's hot files.
//
// Never crashes on a bad font (OTA-safe): an unknown name, a missing file or a file that isn't a font draws the system
// font, with one line in the log per name. Android's own names (serif, monospace, sans-serif-medium, ...) draw the
// phone's matching fonts (ZnFontRules.systemFont); an app file with the same name wins. Any other name iOS has a font
// for draws it, as React Native on iOS: a family name ("Avenir Next") picks its face by fontWeight and fontStyle the
// same way as an app family; a face name ("AvenirNext-Bold") is that face.
//
// iOS differences: a family with no italic face draws its upright face slanted (Compose does the same); one with no
// bold face draws its nearest face, not a thickened one (Compose thickens it).
import CoreText
import Foundation
import UIKit

/// What a fontFamily resolves to for one weight and style.
enum ZnFontChoice {
    /// The phone's font (also every name that has no font: the warning was logged).
    case system(ZnSystemFont)
    /// An app face, slanted when the family has no italic face and italic was asked for.
    case file(CGFont, synthItalic: Bool)
    /// A font iOS has under this name (a family or a face name): ZnFontTable.installedFont.
    case installed(String)
}

/// A made font's cache key: an app face (file) or an installed name, at a size, weight and style.
private struct ZnMadeFont: Hashable {
    let file: ObjectIdentifier?
    let name: String?
    let size: CGFloat
    let weight: Int
    let italic: Bool
}

@MainActor
final class ZnFontTable {
    /// The table of the running bundle (empty until a bundle installs one).
    private(set) static var current = ZnFontTable(fonts: [:])

    /// Sets [current] from a bundle's main.zn.ui.json (parsed); no "fonts" means no app fonts.
    static func install(manifest: [String: Any]?) {
        current = ZnFontTable(fonts: manifest?["fonts"] as? [String: Any] ?? [:])
    }

    private let faces: [String: [ZnFontFace]]
    /// Each face file read: its font, or nil when it can't be read or isn't a font (logged once).
    private var files: [String: CGFont?] = [:]
    /// Each family name's faces that load; empty: the system font (logged once).
    private var families: [String: [(ZnFontFace, CGFont)]] = [:]
    /// Names iOS has a font for (true) or none (false, logged once).
    private var installed: [String: Bool] = [:]
    /// An installed family's faces (face names as `file`), empty for a face name.
    private var installedFaces: [String: [ZnFontFace]] = [:]
    private var made: [ZnMadeFont: UIFont] = [:]

    init(fonts: [String: Any]) { faces = ZnFontRules.parse(fonts) }

    /// The family names this bundle ships.
    var names: [String] { faces.keys.sorted() }

    /// The font for [family] at [weight] and [italic]. Nil and empty names are the system font.
    func choose(_ family: String?, weight: Int, italic: Bool) -> ZnFontChoice {
        guard let family, !family.isEmpty else { return .system(ZnSystemFont()) }
        if faces[family] != nil {
            let loaded = load(family)
            let list = loaded.map(\.0)
            if let (face, synth) = ZnFontRules.pick(list, weight: weight, italic: italic),
               let cg = loaded.first(where: { $0.0 == face })?.1 {
                return .file(cg, synthItalic: synth)
            }
            return .system(ZnSystemFont())
        }
        if let sys = ZnFontRules.systemFont(family) { return .system(sys) }
        if let ok = installed[family] { return ok ? .installed(family) : .system(ZnSystemFont()) }
        let ok = !UIFont.fontNames(forFamilyName: family).isEmpty || UIFont(name: family, size: 12) != nil
        installed[family] = ok
        if !ok { print("zn: font \"\(family)\": this bundle has no such font; drawing the system font") }
        return ok ? .installed(family) : .system(ZnSystemFont())
    }

    /// An app face at [size] (slanted for a synthesized italic), made once per size.
    func uiFont(_ cg: CGFont, size: CGFloat, synthItalic: Bool) -> UIFont {
        let size = ZnFontRules.cacheSize(size)
        let key = ZnMadeFont(file: ObjectIdentifier(cg), name: nil, size: size, weight: 0, italic: synthItalic)
        if let f = made[key] { return f }
        var slant = synthItalic ? ZnFontTable.slant : .identity
        let f = CTFontCreateWithGraphicsFont(cg, size, &slant, nil) as UIFont
        keep(key, f)
        return f
    }

    /// A slant of about 11°, as a synthesized italic (CoreText's text space: y up, so x moves right as y grows).
    private static let slant = CGAffineTransform(a: 1, b: 0, c: 0.2, d: 1, tx: 0, ty: 0)

    /// The font iOS has under [name] at [size], [weight] and [italic]. A family's face is picked as an app family's
    /// (ZnFontRules.pick, condensed faces only when it has no other); a face name is that face. Italic with no italic
    /// face is slanted, as an app font.
    func installedFont(_ name: String, size: CGFloat, weight: Int, italic: Bool) -> UIFont {
        let size = ZnFontRules.cacheSize(size)
        let key = ZnMadeFont(file: nil, name: name, size: size, weight: weight, italic: italic)
        if let f = made[key] { return f }
        var font = UIFont.systemFont(ofSize: size)
        var slanted = false
        if let (face, synth) = ZnFontRules.pick(faces(installed: name), weight: weight, italic: italic),
           let f = UIFont(name: face.file, size: size) {
            font = f
            slanted = synth
        } else if let f = UIFont(name: name, size: size) {
            font = f
            slanted = italic && !f.fontDescriptor.symbolicTraits.contains(.traitItalic)
        }
        if slanted { font = UIFont(descriptor: font.fontDescriptor.withMatrix(ZnFontTable.slant), size: size) }
        keep(key, font)
        return font
    }

    private func faces(installed family: String) -> [ZnFontFace] {
        if let have = installedFaces[family] { return have }
        var all: [(ZnFontFace, condensed: Bool)] = []
        for name in UIFont.fontNames(forFamilyName: family) {
            guard let f = UIFont(name: name, size: 12) else { continue }
            let d = f.fontDescriptor
            let traits = d.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any]
            let w = (traits?[.weight] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 0
            all.append((ZnFontFace(file: name, weight: ZnFontRules.cssWeight(w), italic: d.symbolicTraits.contains(.traitItalic)),
                        d.symbolicTraits.contains(.traitCondensed)))
        }
        let plain = all.filter { !$0.condensed }
        let out = (plain.isEmpty ? all : plain).map(\.0).sorted { $0.file < $1.file }
        installedFaces[family] = out
        return out
    }

    private func keep(_ key: ZnMadeFont, _ f: UIFont) {
        if made.count > 400 { made.removeAll() }  // sizes from an animation or many Dynamic Type changes
        made[key] = f
    }

    private func load(_ family: String) -> [(ZnFontFace, CGFont)] {
        if let have = families[family] { return have }
        var out: [(ZnFontFace, CGFont)] = []
        for face in faces[family] ?? [] {
            if let cg = file(face.file) { out.append((face, cg)) }
        }
        if out.isEmpty { print("zn: font \"\(family)\": none of its files can be read; drawing the system font") }
        families[family] = out
        return out
    }

    private func file(_ path: String) -> CGFont? {
        if let have = files[path] { return have }
        let url = ZnBundles.assetURL(path)
        var cg: CGFont?
        if let data = try? Data(contentsOf: url) {
            cg = ZnFontRules.cgFont(data)
            if cg == nil { print("zn: font \(path) isn't a font; left out") }
        } else {
            print("zn: font \(path) can't be read; left out")
        }
        files[path] = .some(cg)
        return cg
    }
}
