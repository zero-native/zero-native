// Layout values that come from a slot at runtime (registry 23), read as android/runtime reads them: ZnRenderer.kt's
// finiteNum, resolveSizePx, the dynamic shape in dynamicChain, displayNone, and ZnTouch.kt's pointerEventsOf.
// Plain functions over ZnValue (Foundation and CoreGraphics only), so tools/ios-layout-test.ts builds them on the Mac
// without SwiftUI. ZnNodeSpec's "now" readers (ZnTemplate.swift) call these.
import CoreGraphics
import Foundation

/// A size prop: points, or a fraction of the parent.
enum ZnSize: Equatable {
    case points(CGFloat)
    case percent(CGFloat)
}

/// No pointerEvents written (ZnTouch.kt POINTER_EVENTS_UNSET): an element without handlers lets taps through.
let znPointerEventsUnset = -1

/// A slot's number, or nil when it isn't one or isn't finite. NaN and Infinity come from JS easily (a division by 0);
/// a layout never gets them (Android's finiteNum).
func znFinite(_ v: ZnValue) -> CGFloat? {
    if case .number(let n) = v, n.isFinite { return CGFloat(n) }
    return nil
}

/// A width or height from a slot (Android's resolveSizePx): a number is points, "50%" a fraction of the parent.
/// "auto", any other text, NaN and null are not written (nil).
func znSizeValue(_ v: ZnValue) -> ZnSize? {
    switch v {
    case .number(let n): return n.isFinite ? .points(CGFloat(n)) : nil
    case .percent(let f): return f.isFinite ? .percent(CGFloat(max(f, 0))) : nil
    case .string(let s):
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.hasSuffix("%"), let n = Double(t.dropLast().trimmingCharacters(in: .whitespaces)), n.isFinite else { return nil }
        return .percent(CGFloat(max(n, 0) / 100))
    default: return nil
    }
}

/// The four corners (topStart, topEnd, bottomEnd, bottomStart) with slots filled in, in Android's order: a corner's
/// own slot, else its written static value, else the borderRadius slot, else the static corner (which is borderRadius
/// when the corner isn't written). Negative counts as 0.
func znCorners(fixed: [CGFloat], written: [Bool], cornerSlots: [CGFloat?], all: CGFloat?) -> [CGFloat] {
    (0..<4).map { i in
        max(cornerSlots[i] ?? (written[i] ? fixed[i] : nil) ?? all ?? fixed[i], 0)
    }
}

/// pointerEvents from a slot ("none", "box-none", "box-only", "auto"); anything else is as if not written.
func znPointerEvents(_ v: ZnValue) -> Int {
    switch v.string {
    case "none": return Registry.PointerEvents.none
    case "box-none": return Registry.PointerEvents.boxNone
    case "box-only": return Registry.PointerEvents.boxOnly
    case "auto": return Registry.PointerEvents.auto
    default: return znPointerEventsUnset
    }
}

/// display from a slot: "none" (or the enum's number) hides the element.
func znDisplayNone(_ v: ZnValue) -> Bool {
    switch v {
    case .string(let s): return s == "none"
    case .number(let n): return Int(exactly: n) == Registry.Display.none
    case .enumValue(let e): return e == Registry.Display.none
    default: return false
    }
}
