// iOS's <Canvas> parser and drawing (ZnCanvasParse.swift, ZnCanvasDraw.swift, ZnPathData.swift), on the Mac:
// tools/ios-unit-test.ts builds this with the files in sources.txt. The parse cases are android/runtime's
// ZnCanvasTest.kt, with the same JSON and answers (motion values: iOS reads none yet, so each one is "gone", as on
// Android for a value that is gone). The draw cases render small lists into a 100 × 100 bitmap, flipped to UIKit's
// y-down, and look at pixels.
import CoreGraphics
import CoreText
import ImageIO
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

func ok(_ name: String, _ cond: Bool, _ detail: @autoclosure () -> String = "", line: Int = #line) {
    count += 1
    if !cond {
        failures += 1
        print("FAIL \(name) (line \(line)) \(detail())")
    }
}

// Colours are ARGB numbers (core canvas.ts converts them in JS).
let RED: UInt32 = 0xFFFF_0000, GREEN: UInt32 = 0xFF00_FF00, BLUE: UInt32 = 0xFF00_00FF, BLACK: UInt32 = 0xFF00_0000

func parse(_ json: String, _ density: CGFloat = 1) -> ZnCanvasCommands { znParseCanvasCommands(json, density: density) }

// ---- Parse (ZnCanvasTest.kt) -------------------------------------------------------------------------------------

do {  // parsesBasicShapesAndCommands
    let p = parse("""
    [
        {"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50, "paint": {"color": \(RED), "style": "fill"}},
        {"type": "circle", "cx": 40, "cy": 40, "r": 20, "paint": {"color": \(GREEN)}},
        {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 50, "paint": {"strokeWidth": 2}},
        {"type": "text", "text": "Test", "x": 10, "y": 30, "options": {"fontSize": 16, "fontWeight": "bold"}},
        {"type": "save"},
        {"type": "translate", "dx": 5, "dy": 10},
        {"type": "restore"}
    ]
    """)
    check("basic errors", p.errors, [])
    check("basic count", p.ops.count, 7)
    let rect = p.ops[0] as? ZnCanvasOp.Rect
    check("rect x", rect?.x.value, 10)
    check("rect y", rect?.y.value, 20)
    check("rect w", rect?.w.value, 100)
    check("rect h", rect?.h.value, 50)
    check("rect colour", rect?.paint.color.value, RED)
    let circle = p.ops[1] as? ZnCanvasOp.Circle
    check("circle cx", circle?.cx.value, 40)
    check("circle r", circle?.r.value, 20)
    check("circle colour", circle?.paint.color.value, GREEN)
    let text = p.ops[3] as? ZnCanvasOp.Text
    check("text", text?.text, "Test")
    check("text size", text?.fontSize, 16)
    check("text weight", text?.fontWeight, 700)
}

do {  // positionsAreScaledByDensity
    let rect = parse(#"[{"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50, "paint": {"style": "stroke", "strokeWidth": 2}}]"#, 3).ops[0] as? ZnCanvasOp.Rect
    check("density x", rect?.x.value, 30)
    check("density w", rect?.w.value, 300)
    check("density stroke", rect?.paint.width(), 6)
}

do {  // skipsMalformedCommandGracefully
    let p = parse("""
    [
        {"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50},
        {"type": "corrupted_non_existent", "bad": true},
        {"type": "save"}
    ]
    """)
    check("malformed count", p.ops.count, 2)
    ok("malformed rect", p.ops[0] is ZnCanvasOp.Rect)
    ok("malformed save", p.ops[1] is ZnCanvasOp.Save)
    check("malformed errors", p.errors.count, 1)
    ok("malformed index", p.errors.first?.hasPrefix("command 1:") == true, "\(p.errors)")
}

do {  // knownCommandWithMissingOrWrongFieldIsDroppedAndNamed
    let p = parse("""
    [
        {"type": "circle", "cx": 10, "cy": 10},
        {"type": "rect", "x": "ten", "y": 0, "w": 10, "h": 10},
        {"type": "path"},
        {"type": "circle", "cx": 10, "cy": 10, "r": 5}
    ]
    """)
    check("missing count", p.ops.count, 1)
    ok("missing circle", p.ops.first is ZnCanvasOp.Circle)
    check("missing errors", p.errors.count, 3)
    if p.errors.count == 3 {
        ok("r named", p.errors[0].hasPrefix("command 0:") && p.errors[0].contains("\"r\""), p.errors[0])
        ok("x named", p.errors[1].hasPrefix("command 1:") && p.errors[1].contains("\"x\""), p.errors[1])
        ok("d named", p.errors[2].hasPrefix("command 2:") && p.errors[2].contains("\"d\""), p.errors[2])
    }
    check("missing text", p.errors.first, "command 0: \"r\" is missing; skipped")
}

do {  // nullAndFalseEntriesAreSkippedSilently
    let p = parse(#"[null, false, {"type": "save"}, {"type": "restore"}]"#)
    check("null false count", p.ops.count, 2)
    check("null false errors", p.errors, [])
    // true is not a command.
    check("true", parse(#"[true]"#).errors, ["command 0: not a command object"])
}

do {  // restoreWithoutSaveIsDroppedWithOneError
    let p = parse(#"[{"type": "restore"}, {"type": "save"}, {"type": "restore"}, {"type": "restore"}]"#)
    check("restore count", p.ops.count, 2)
    check("restore errors", p.errors.count, 2)
    ok("restore 0", p.errors.first?.hasPrefix("command 0:") == true)
    ok("restore 3", p.errors.last?.hasPrefix("command 3:") == true)
}

do {  // oneColourGradientDrawsSolidWithoutBrush
    let p = parse("""
    [
        {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": \(RED), "linearGradient": {"x0": 0, "y0": 0, "x1": 10, "y1": 0, "colors": [\(BLUE)]}}},
        {"type": "circle", "cx": 5, "cy": 5, "r": 5, "paint": {"color": \(RED), "radialGradient": {"cx": 5, "cy": 5, "r": 5, "colors": []}}}
    ]
    """)
    check("one colour count", p.ops.count, 2)
    let rect = p.ops[0] as? ZnCanvasOp.Rect
    ok("one colour no gradient", rect?.paint.gradient == nil)
    check("the one colour", rect?.paint.color.value, BLUE)
    let circle = p.ops[1] as? ZnCanvasOp.Circle
    ok("no colours no gradient", circle?.paint.gradient == nil)
    check("no colours: paint colour", circle?.paint.color.value, RED)
    check("one colour errors", p.errors.count, 2)
}

do {  // gradientStopsThatDontMatchAreDropped
    let p = parse(#"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 10, "y1": 0, "colors": [\#(RED), \#(BLUE)], "stops": [0, 0.5, 1]}}}]"#)
    let rect = p.ops[0] as? ZnCanvasOp.Rect
    check("stops dropped", rect?.paint.gradient, .linear(start: .zero, end: CGPoint(x: 10, y: 0), colors: [RED, BLUE], stops: nil))
    check("stops errors", p.errors.count, 1)
}

do {  // dashOfLengthOneIsDropped
    let p = parse("""
    [
        {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [4]}},
        {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [0, 0]}},
        {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [4, -1]}},
        {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [4, 2]}}
    ]
    """, 2)
    check("dash count", p.ops.count, 4)
    let dashes = p.ops.map { ($0 as? ZnCanvasOp.Line)?.paint.dash }
    check("dash odd", dashes[0], nil)
    check("dash zero", dashes[1], nil)
    check("dash negative", dashes[2], nil)
    check("dash good", dashes[3], [8, 4])
    check("dash errors", p.errors.count, 3)
    ok("dash 0", p.errors.first?.hasPrefix("command 0:") == true)
}

do {  // nonFiniteNumbersAreRefused
    let p = parse("""
    [
        {"type": "circle", "cx": null, "cy": 0, "r": 5},
        {"type": "rect", "x": 1e300, "y": 0, "w": 10, "h": 10},
        {"type": "circle", "cx": 5, "cy": 5, "r": 5, "paint": {"radialGradient": {"cx": 5, "cy": 5, "r": 1e300, "colors": [\(RED), \(BLUE)]}}},
        {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10}
    ]
    """)
    check("non-finite count", p.ops.count, 1)
    ok("non-finite rect", p.ops.first is ZnCanvasOp.Rect)
    check("non-finite errors", p.errors.count, 3)
    // iOS only: a JSON true where a number belongs is not a number (NSNumber holds both).
    let b = parse(#"[{"type": "circle", "cx": true, "cy": 0, "r": 5}]"#)
    check("bool number", b.errors, ["command 0: \"cx\" is not a finite number; skipped"])
}

do {  // stringColourIsBlackWithAnError
    let p = parse(##"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": "#FF000080"}}]"##)
    check("string colour", (p.ops[0] as? ZnCanvasOp.Rect)?.paint.color.value, BLACK)
    check("string colour errors", p.errors.count, 1)
}

do {  // argbNumbersKeepAlpha
    let p = parse(#"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": 2164195328}}]"#)
    check("argb alpha", (p.ops[0] as? ZnCanvasOp.Rect)?.paint.color.value, 0x80FF_0000)
    // A negative Int (Kotlin's signed ARGB) is the same colour.
    let n = parse(#"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": -16777216}}]"#)
    check("signed argb", (n.ops[0] as? ZnCanvasOp.Rect)?.paint.color.value, BLACK)
}

do {  // pathGradientBrushIsBuiltInDp
    let p = parse(#"[{"type": "path", "d": "M0 0 L100 0 L100 50 Z", "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 0, "y1": 50, "colors": [\#(RED), \#(BLUE)]}}}]"#, 3)
    check("path gradient dp", (p.ops[0] as? ZnCanvasOp.PathOp)?.paint.gradient,
          .linear(start: .zero, end: CGPoint(x: 0, y: 50), colors: [RED, BLUE], stops: nil))
    let r = parse(#"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 0, "y1": 50, "colors": [\#(RED), \#(BLUE)]}}}]"#, 3)
    check("rect gradient px", (r.ops[0] as? ZnCanvasOp.Rect)?.paint.gradient,
          .linear(start: .zero, end: CGPoint(x: 0, y: 150), colors: [RED, BLUE], stops: nil))
}

do {  // strokeWidthMinimumIsOnePixelForPathsToo
    let ops = parse("""
    [
        {"type": "path", "d": "M0 0 L10 0", "paint": {"style": "stroke", "strokeWidth": 0}},
        {"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0, "paint": {"strokeWidth": 0}}
    ]
    """, 2).ops
    check("path min width", (ops[0] as? ZnCanvasOp.PathOp)?.paint.width(), 0.5)
    check("line min width", (ops[1] as? ZnCanvasOp.Line)?.paint.width(), 1)
    // iOS: density 1, three pixels a point: one pixel is a third of a point.
    let ios = znParseCanvasCommands(#"[{"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0, "paint": {"strokeWidth": 0}}]"#, density: 1, pixels: 3)
    check("one pixel at 3x", (ios.ops[0] as? ZnCanvasOp.Line)?.paint.width(), 1.0 / 3)
}

do {  // malformedJsonGivesNothingAndAnError
    let p = parse(#"[{"type": "rect", "#)
    check("bad json ops", p.ops.count, 0)
    check("bad json errors", p.errors.count, 1)
    let n = parse(#"{"type": "rect"}"#)
    check("not array ops", n.ops.count, 0)
    check("not array errors", n.errors.count, 1)
    check("empty", parse("").ops.count + parse("[]").ops.count + parse("null").ops.count + znParseCanvasCommands(nil).ops.count, 0)
}

func saves(_ n: Int) -> String { "[" + Array(repeating: #"{"type":"save"}"#, count: n).joined(separator: ",") + "]" }

do {  // allowsExactlyTheLimit / refusesOneOverTheLimit
    let p = parse(saves(znMaxCanvasCommands))
    check("limit ops", p.ops.count, znMaxCanvasCommands)
    check("limit errors", p.errors, [])
    let over = parse(saves(znMaxCanvasCommands + 1))
    check("over ops", over.ops.count, 0)
    check("over errors", over.errors, ["10001 commands, more than the 10000 allowed; nothing is drawn"])
}

do {  // errorListIsCapped
    let p = parse("[" + Array(repeating: #"{"type":"nope"}"#, count: 50).joined(separator: ",") + "]")
    check("capped", p.errors.count, 11)
    check("and more", p.errors.last, "and 40 more")
    check("unknown text", p.errors.first, "command 0: unknown type \"nope\"; skipped")
}

// ---- Motion values: none on iOS yet, so each is "gone" (Android's words for a value that is gone) ----------------

do {  // aMotionValueThatIsGoneDrawsAsZeroWithAWarning
    let p = parse(#"[{"type": "circle", "cx": "\u0000m987654", "cy": 5, "r": 5}]"#)
    check("gone count", p.ops.count, 1)
    check("gone value", (p.ops.first as? ZnCanvasOp.Circle)?.cx.value, 0)
    check("gone error", p.errors, ["command 0: \"cx\" follows motion value 987654, which is gone; 0 is used"])
}

do {  // aNumberMotionValueAsAColourIsBlackWithAWarning (here: gone, black)
    let p = parse(#"[{"type": "text", "text": "a", "x": 0, "y": 10, "options": {"color": "\u0000m5104"}}]"#)
    check("motion colour black", (p.ops.first as? ZnCanvasOp.Text)?.color.value, BLACK)
    check("motion colour errors", p.errors.count, 1)
}

do {  // aMotionValueWhereNoneIsAllowedSkipsTheCommand
    let p = parse("""
    [
        {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": "\\u0000m5105", "y0": 0, "x1": 10, "y1": 0, "colors": [\(RED), \(BLUE)]}}},
        {"type": "paragraph", "text": "a", "x": 0, "y": 0, "width": "\\u0000m5105"},
        {"type": "text", "text": "a", "x": 0, "y": 10, "options": {"fontSize": "\\u0000m5105"}}
    ]
    """)
    check("not allowed ops", p.ops.count, 0)
    check("not allowed errors", p.errors.count, 3)
}

do {  // pathTrimsParse (trimEnd's motion value is gone here: 0, with a warning)
    let p = parse("""
    [
        {"type": "path", "d": "M0 0 L10 0", "trimEnd": "\\u0000m5106", "trimStart": 0},
        {"type": "path", "d": "M0 0 L10 0"},
        {"type": "path", "d": "M0 0 L10 0", "trimOffset": "nope"}
    ]
    """, 3)
    check("trims ops", p.ops.count, 2)
    let t = p.ops.first as? ZnCanvasOp.PathOp
    check("trimmed", t?.trimmed, true)
    check("trimEnd gone", t?.trimEnd?.value, 0)
    check("trimStart", t?.trimStart?.value, 0)
    ok("no trimOffset", t?.trimOffset == nil)
    check("untrimmed", (p.ops[1] as? ZnCanvasOp.PathOp)?.trimmed, false)
    check("trims errors", p.errors.count, 2)  // Android: 1 (its motion value exists)
}

// ---- New commands (C4-C7) ----------------------------------------------------------------------------------------

do {  // paragraphParses
    let p = parse("""
    [
        {"type": "paragraph", "text": "Hello there", "x": 10, "y": 20, "width": 100, "options": {"fontSize": 12, "fontWeight": "bold", "align": "center", "lineHeight": 18, "maxLines": 2, "color": \(RED)}},
        {"type": "paragraph", "text": "a", "x": 0, "y": 0, "width": 0},
        {"type": "paragraph", "text": "a", "x": 0, "y": 0, "width": 50, "options": {"maxLines": 0, "lineHeight": -1}}
    ]
    """, 2)
    check("paragraph ops", p.ops.count, 2)
    let a = p.ops[0] as? ZnCanvasOp.Paragraph
    check("paragraph width", a?.width, 200)
    check("paragraph size", a?.fontSizePx, 24)
    check("paragraph weight", a?.fontWeight, 700)
    check("paragraph align", a?.align, 1)
    check("paragraph lineHeight", a?.lineHeight, 36)
    check("paragraph maxLines", a?.maxLines, 2)
    check("paragraph colour", a?.color.value, RED)
    check("paragraph y", a?.y.value, 40)
    let loose = p.ops[1] as? ZnCanvasOp.Paragraph
    check("loose maxLines", loose?.maxLines, Int.max)
    check("loose lineHeight", loose?.lineHeight, 0)
    check("paragraph errors", p.errors.count, 3)
}

do {  // imageParses
    let p = parse("""
    [
        {"type": "image", "src": "asset:images/a.png", "x": 0, "y": 0, "w": 80, "h": 40, "options": {"fit": "contain", "radius": 8, "opacity": 0.5}},
        {"type": "image", "src": "https://x.test/a.png", "x": 0, "y": 0, "w": 9000, "h": 10},
        {"type": "image", "x": 0, "y": 0, "w": 10, "h": 10},
        {"type": "image", "src": "a", "x": 0, "y": 0, "w": 10, "h": 10, "options": {"fit": "zoom"}}
    ]
    """, 2)
    check("image ops", p.ops.count, 3)
    let a = p.ops[0] as? ZnCanvasOp.Image
    check("image fit", a?.fit, znFitContain)
    check("image decodeW", a?.decodeW, 160)
    check("image decodeH", a?.decodeH, 80)
    check("image radius", a?.radius?.value, 16)
    check("image opacity", a?.opacity.value, 0.5)
    let b = p.ops[1] as? ZnCanvasOp.Image
    check("image cover", b?.fit, znFitCover)
    check("image capped", b?.decodeW, 4096)
    ok("image no radius", b?.radius == nil)
    check("unknown fit", (p.ops[2] as? ZnCanvasOp.Image)?.fit, znFitCover)
    check("image errors", p.errors.count, 2)
    // iOS: decoded in pixels (points × screen scale).
    let i = znParseCanvasCommands(#"[{"type": "image", "src": "a", "x": 0, "y": 0, "w": 100, "h": 90}]"#, density: 1, pixels: 3)
    check("decode at 3x", (i.ops[0] as? ZnCanvasOp.Image)?.key, "a|300x270")
}

do {  // clipsTakeAnOp
    let p = parse("""
    [
        {"type": "clipRect", "x": 0, "y": 0, "w": 10, "h": 10},
        {"type": "clipRect", "x": 0, "y": 0, "w": 10, "h": 10, "op": "difference"},
        {"type": "clipRoundRect", "x": 0, "y": 0, "w": 10, "h": 10, "r": 4, "op": "difference"},
        {"type": "clipPath", "d": "M0 0 L10 0 L10 10 Z", "op": "intersect", "fillType": "evenOdd"},
        {"type": "clipRect", "x": 0, "y": 0, "w": 10, "h": 10, "op": "union"},
        {"type": "clipPath", "op": "difference"}
    ]
    """, 2)
    check("clip ops", p.ops.count, 5)
    check("intersect", (p.ops[0] as? ZnCanvasOp.ClipRect)?.difference, false)
    check("difference", (p.ops[1] as? ZnCanvasOp.ClipRect)?.difference, true)
    let rr = p.ops[2] as? ZnCanvasOp.ClipRoundRect
    check("rr difference", rr?.difference, true)
    check("rr r", rr?.r.value, 8)
    let cp = p.ops[3] as? ZnCanvasOp.ClipPath
    check("clipPath evenOdd", cp?.evenOdd, true)
    check("clipPath scale", cp?.scale, 2)
    check("clipPath in points", cp?.path.boundingBox, CGRect(x: 0, y: 0, width: 20, height: 20))
    check("unknown op", (p.ops[4] as? ZnCanvasOp.ClipRect)?.difference, false)
    check("clip errors", p.errors.count, 2)
    check("unknown op text", p.errors.first, "command 4: op \"union\" is not known; intersect is used")
}

do {  // paintEffectsParse
    let p = parse("""
    [
        {"type": "path", "d": "M0 0 L10 0 L10 10 Z", "paint": {"fillType": "evenOdd", "blendMode": "multiply"}},
        {"type": "circle", "cx": 5, "cy": 5, "r": 5, "paint": {"sweepGradient": {"cx": 5, "cy": 5, "colors": [\(RED), \(BLUE)], "stops": [0, 1], "startAngle": -90}}},
        {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"shadow": {"dx": 1, "dy": 2, "blur": 4, "color": \(RED)}, "blur": 3}},
        {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"shadow": {"dx": 1, "dy": 2, "blur": 4, "color": "#000"}, "blendMode": "hue", "blur": -1}}
    ]
    """, 2)
    check("fx ops", p.ops.count, 4)
    check("fx layer", p.needsLayer, true)
    let path = (p.ops[0] as? ZnCanvasOp.PathOp)?.paint
    check("evenOdd", path?.evenOdd, true)
    check("multiply", path?.blend, .multiply)
    check("sweep", (p.ops[1] as? ZnCanvasOp.Circle)?.paint.gradient,
          .sweep(center: CGPoint(x: 10, y: 10), colors: [RED, BLUE], stops: [0, 1], startAngle: -90))
    let fx = (p.ops[2] as? ZnCanvasOp.Rect)?.paint
    check("hasFx", fx?.hasFx, true)
    check("shadow dx", fx?.shadow?.dx, 2)
    check("shadow blur", fx?.shadow?.blur, 8)
    check("blur", fx?.blur, 6)
    let bad = (p.ops[3] as? ZnCanvasOp.Rect)?.paint
    ok("bad shadow", bad?.shadow == nil)
    check("bad blend", bad?.blend, .normal)
    check("bad blur", bad?.blur, 0)
    check("fx errors", p.errors.count, 3)
}

do {  // noBlendModeNeedsNoLayer
    check("no layer", parse(#"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"blendMode": "srcOver"}}]"#).needsLayer, false)
}

// ---- Path data ---------------------------------------------------------------------------------------------------

do {
    check("path ok", ZnPathData.parse("M 20 50 Q 80 10, 140 50 T 260 50 T 320 50").ok, true)
    check("packed numbers", ZnPathData.parse("M1.5.5L-.5-1e1").path.currentPoint, CGPoint(x: -0.5, y: -10))
    check("arc flags packed", ZnPathData.parse("M0 0a5 5 0 1010 0").ok, true)
    check("relative after Z", ZnPathData.parse("M 10 10 h 10 v 10 Z m 5 5").path.currentPoint, CGPoint(x: 15, y: 15))
    check("line first", ZnPathData.parse("L 10 10").path.currentPoint, CGPoint(x: 10, y: 10))
    check("bad letter", ZnPathData.parse("M 0 0 X 5 5").ok, false)
    check("garbage", ZnPathData.parse("M 0 0 L 5 @").ok, false)
    check("short at end", ZnPathData.parse("M 0 0 L 5").ok, true)
    check("empty", ZnPathData.parse("").ok, true)
    let bad = parse(#"[{"type": "path", "d": "M 0 0 X"}]"#)
    check("bad d", bad.errors, ["command 0: \"d\" is not valid path data; skipped"])
}

// ---- Drawing: pixels -----------------------------------------------------------------------------------------------

/// A 100 × 100 RGBA bitmap drawn with [json], y down like UIKit, base space the bitmap's own (as for any bitmap).
final class Bitmap {
    let w: Int, h: Int
    let ctx: CGContext
    init(_ json: String, w: Int = 100, h: Int = 100, background: UInt32? = nil, setup: ((ZnCanvasCommands) -> Void)? = nil) {
        self.w = w
        self.h = h
        ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        if let background {
            ctx.setFillColor(CGColor(srgbRed: CGFloat(background >> 16 & 0xFF) / 255, green: CGFloat(background >> 8 & 0xFF) / 255,
                                     blue: CGFloat(background & 0xFF) / 255, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        let c = znParseCanvasCommands(json)
        if !c.errors.isEmpty { print("note: \(c.errors)") }
        setup?(c)
        znDrawCanvas(ctx, c, size: CGSize(width: w, height: h), base: .identity)
    }

    /// (r, g, b, a) at (x, y), y from the top.
    func at(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
        guard let data = ctx.data, x >= 0, y >= 0, x < w, y < h else { return (0, 0, 0, 0) }
        let p = data.assumingMemoryBound(to: UInt8.self) + (y * w + x) * 4
        return (Int(p[0]), Int(p[1]), Int(p[2]), Int(p[3]))
    }

    func alpha(_ x: Int, _ y: Int) -> Int { at(x, y).a }

    /// Rows with any ink.
    func inkRows() -> [Int] { (0..<h).filter { y in (0..<w).contains { alpha($0, y) > 0 } } }
    func inkColumns() -> [Int] { (0..<w).filter { x in (0..<h).contains { alpha(x, $0) > 0 } } }
}

func near(_ a: (r: Int, g: Int, b: Int, a: Int), _ r: Int, _ g: Int, _ b: Int, _ al: Int = 255, by k: Int = 8) -> Bool {
    abs(a.r - r) <= k && abs(a.g - g) <= k && abs(a.b - b) <= k && abs(a.a - al) <= k
}

do {  // a red rect at (10, 20)
    let b = Bitmap(#"[{"type": "rect", "x": 10, "y": 20, "w": 30, "h": 30, "paint": {"color": \#(RED)}}]"#)
    ok("rect red inside", near(b.at(15, 25), 255, 0, 0), "\(b.at(15, 25))")
    check("rect clear outside", b.alpha(5, 5), 0)
    check("rect clear below", b.alpha(15, 55), 0)
}

do {  // a translate inside save / restore doesn't leak; one left open doesn't either (the next draw is clean)
    let b = Bitmap("""
    [{"type": "save"}, {"type": "translate", "dx": 50, "dy": 0}, {"type": "restore"},
     {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": \(RED)}},
     {"type": "translate", "dx": 1000, "dy": 0}]
    """)
    ok("restored", near(b.at(5, 5), 255, 0, 0))
    check("not moved", b.alpha(55, 5), 0)
    let ctm = b.ctx.ctm
    check("open translate undone", ctm.tx, 0)
}

do {  // a difference clip leaves a hole
    let b = Bitmap("""
    [{"type": "save"}, {"type": "clipRect", "x": 40, "y": 40, "w": 20, "h": 20, "op": "difference"},
     {"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": \(BLACK)}}, {"type": "restore"}]
    """)
    check("hole", b.alpha(50, 50), 0)
    check("around hole", b.alpha(30, 50), 255)
    let r = Bitmap("""
    [{"type": "clipRoundRect", "x": 20, "y": 20, "w": 60, "h": 60, "r": 20, "op": "difference"},
     {"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": \(BLACK)}}]
    """)
    check("round hole middle", r.alpha(50, 50), 0)
    check("round hole corner is covered", r.alpha(22, 22), 255)
    let i = Bitmap("""
    [{"type": "clipPath", "d": "M 0 0 L 100 0 L 100 100 Z"},
     {"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": \(BLACK)}}]
    """)
    check("clipPath inside", i.alpha(90, 10), 255)
    check("clipPath outside", i.alpha(10, 90), 0)
}

do {  // a sweep gradient at startAngle -90 starts at 12 o'clock and goes clockwise
    let b = Bitmap(#"[{"type": "circle", "cx": 50, "cy": 50, "r": 50, "paint": {"sweepGradient": {"cx": 50, "cy": 50, "colors": [\#(RED), \#(BLUE)], "startAngle": -90}}}]"#)
    let justRight = b.at(53, 5), justLeft = b.at(47, 5), right = b.at(95, 50), bottom = b.at(50, 95)
    ok("sweep starts red at the top", justRight.r > 230 && justRight.b < 25, "\(justRight)")
    ok("sweep ends blue left of the top", justLeft.b > 230 && justLeft.r < 25, "\(justLeft)")
    ok("sweep a quarter at 3 o'clock", abs(right.r - 191) < 20 && abs(right.b - 64) < 20, "\(right)")
    ok("sweep half at 6 o'clock", abs(bottom.r - 128) < 20 && abs(bottom.b - 128) < 20, "\(bottom)")
}

do {  // linear and radial gradients clamp past their ends
    let l = Bitmap(#"[{"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"linearGradient": {"x0": 20, "y0": 0, "x1": 80, "y1": 0, "colors": [\#(RED), \#(BLUE)]}}}]"#)
    ok("linear before start", near(l.at(5, 50), 255, 0, 0), "\(l.at(5, 50))")
    ok("linear after end", near(l.at(95, 50), 0, 0, 255), "\(l.at(95, 50))")
    ok("linear middle", abs(l.at(50, 50).r - 128) < 12, "\(l.at(50, 50))")
    let r = Bitmap(#"[{"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"radialGradient": {"cx": 50, "cy": 50, "r": 30, "colors": [\#(RED), \#(BLUE)]}}}]"#)
    ok("radial centre", near(r.at(50, 50), 255, 0, 0, by: 12), "\(r.at(50, 50))")
    ok("radial outside", near(r.at(2, 2), 0, 0, 255), "\(r.at(2, 2))")
    // A gradient stroke paints only the stroke.
    let s = Bitmap(#"[{"type": "rect", "x": 20, "y": 20, "w": 60, "h": 60, "paint": {"style": "stroke", "strokeWidth": 4, "linearGradient": {"x0": 0, "y0": 0, "x1": 100, "y1": 0, "colors": [\#(RED), \#(BLUE)]}}}]"#)
    check("gradient stroke edge", s.alpha(20, 50), 255)
    check("gradient stroke inside", s.alpha(50, 50), 0)
}

do {  // a stroke dash leaves gaps
    let b = Bitmap(#"[{"type": "line", "x1": 0, "y1": 50, "x2": 100, "y2": 50, "paint": {"style": "stroke", "strokeWidth": 4, "color": \#(BLACK), "dash": [10, 10]}}]"#)
    check("dash on", b.alpha(5, 50), 255)
    check("dash off", b.alpha(15, 50), 0)
    check("dash on again", b.alpha(25, 50), 255)
}

do {  // a trimEnd of 0.5 draws half a line (a path)
    let b = Bitmap(#"[{"type": "path", "d": "M 0 50 L 100 50", "paint": {"style": "stroke", "strokeWidth": 4, "color": \#(BLACK)}, "trimEnd": 0.5}]"#)
    check("trim drawn", b.alpha(25, 50), 255)
    check("trim cut", b.alpha(75, 50), 0)
    let none = Bitmap(#"[{"type": "path", "d": "M 0 50 L 100 50", "paint": {"style": "stroke", "strokeWidth": 4, "color": \#(BLACK)}, "trimEnd": 0}]"#)
    check("trim nothing", none.inkRows(), [])
}

do {  // a srcIn layer doesn't punch through: what was behind the canvas stays
    let b = Bitmap("""
    [{"type": "rect", "x": 0, "y": 0, "w": 50, "h": 100, "paint": {"color": \(RED)}},
     {"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": \(BLUE), "blendMode": "srcIn"}}]
    """, background: 0xFF00_FF00)
    ok("srcIn over own red is blue", near(b.at(25, 50), 0, 0, 255), "\(b.at(25, 50))")
    ok("srcIn leaves the background", near(b.at(75, 50), 0, 255, 0), "\(b.at(75, 50))")
    let c = Bitmap("""
    [{"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": \(RED)}},
     {"type": "circle", "cx": 50, "cy": 50, "r": 20, "paint": {"blendMode": "clear"}}]
    """, background: 0xFF00_FF00)
    ok("clear shows the background, not a hole", near(c.at(50, 50), 0, 255, 0), "\(c.at(50, 50))")
    ok("clear outside keeps red", near(c.at(5, 5), 255, 0, 0), "\(c.at(5, 5))")
    let m = Bitmap("""
    [{"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": 4294934352}},
     {"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": 4285497343, "blendMode": "multiply"}}]
    """)
    // 0xFFFF7F50 (coral) × 0xFF6F7FFF: r 255·111/255, g 127·127/255, b 80·255/255.
    ok("multiply", near(m.at(50, 50), 111, 63, 80, by: 3), "\(m.at(50, 50))")
}

do {  // evenOdd: a square with a square hole
    let b = Bitmap(#"[{"type": "path", "d": "M 10 10 h 80 v 80 h -80 Z M 30 30 h 40 v 40 h -40 Z", "paint": {"color": \#(BLACK), "fillType": "evenOdd"}}]"#)
    check("evenOdd ring", b.alpha(20, 50), 255)
    check("evenOdd hole", b.alpha(50, 50), 0)
    let n = Bitmap(#"[{"type": "path", "d": "M 10 10 h 80 v 80 h -80 Z M 30 30 h 40 v 40 h -40 Z", "paint": {"color": \#(BLACK)}}]"#)
    check("nonZero fills", n.alpha(50, 50), 255)
}

do {  // shapes: round rect corners, arcs from 3 o'clock clockwise, opacity
    let rr = Bitmap(#"[{"type": "roundRect", "x": 10, "y": 10, "w": 80, "h": 80, "r": 500, "paint": {"color": \#(BLACK)}}]"#)
    check("radius clamped: a circle", rr.alpha(12, 12), 0)
    check("radius clamped: centre", rr.alpha(50, 50), 255)
    let a = Bitmap(#"[{"type": "arc", "x": 0, "y": 0, "w": 100, "h": 100, "start": 0, "sweep": 90, "useCenter": true, "paint": {"color": \#(BLACK)}}]"#)
    check("arc bottom right", a.alpha(70, 70), 255)
    check("arc top right empty", a.alpha(70, 30), 0)
    check("arc bottom left empty", a.alpha(30, 70), 0)
    let z = Bitmap(#"[{"type": "arc", "x": 0, "y": 0, "w": 100, "h": 100, "start": 0, "sweep": 0, "useCenter": true, "paint": {"color": \#(BLACK)}}]"#)
    check("arc sweep 0 draws nothing", z.inkRows(), [])
    let o = Bitmap(#"[{"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "paint": {"color": \#(BLACK), "opacity": 0.5}}]"#)
    ok("opacity", abs(o.alpha(50, 50) - 128) <= 1, "\(o.alpha(50, 50))")
    let rot = Bitmap(#"[{"type": "rotate", "degrees": 90, "px": 50, "py": 50}, {"type": "rect", "x": 50, "y": 45, "w": 50, "h": 10, "paint": {"color": \#(BLACK)}}]"#)
    check("rotate 90 clockwise: right goes down", rot.alpha(50, 80), 255)
    check("rotate: right is empty", rot.alpha(80, 50), 0)
    let sc = Bitmap(#"[{"type": "scale", "sx": 2}, {"type": "rect", "x": 0, "y": 0, "w": 20, "h": 20, "paint": {"color": \#(BLACK)}}]"#)
    check("scale both", sc.alpha(35, 35), 255)
}

do {  // shadow: below the rect (dy 4), not above; it follows a rotate
    let b = Bitmap(#"[{"type": "rect", "x": 30, "y": 30, "w": 40, "h": 40, "paint": {"color": 4294967295, "shadow": {"dx": 0, "dy": 6, "blur": 4, "color": \#(BLACK)}}}]"#)
    ok("shadow below", b.alpha(50, 74) > 40, "\(b.alpha(50, 74))")
    ok("no shadow above", b.alpha(50, 26) < 10, "\(b.alpha(50, 26))")
    ok("card itself white", near(b.at(50, 50), 255, 255, 255), "\(b.at(50, 50))")
    let r = Bitmap("""
    [{"type": "rotate", "degrees": 90, "px": 50, "py": 50},
     {"type": "rect", "x": 30, "y": 30, "w": 40, "h": 40, "paint": {"color": 4294967295, "shadow": {"dx": 0, "dy": 6, "blur": 4, "color": \(BLACK)}}}]
    """)
    // The card's "down" is the screen's left after a quarter turn clockwise.
    ok("turned shadow left", r.alpha(26, 50) > 40, "\(r.alpha(26, 50))")
    ok("turned: none right", r.alpha(74, 50) < 10, "\(r.alpha(74, 50))")
}

do {  // blur: a soft circle with no sharp disc, and nothing drawn sharp anywhere
    let b = Bitmap(#"[{"type": "circle", "cx": 50, "cy": 50, "r": 20, "paint": {"color": \#(BLACK), "blur": 10}}]"#)
    let centre = b.alpha(50, 50), edge = b.alpha(70, 50), out = b.alpha(78, 50)
    ok("blur centre mostly ink", centre > 150, "\(centre)")
    ok("blur edge half", edge > 50 && edge < 200, "\(edge)")
    ok("blur outside soft", out > 3 && out < 100, "\(out)")
    check("blur nothing at the far edge", b.alpha(99, 50), 0)
    let big = Bitmap(#"[{"type": "circle", "cx": 50, "cy": 50, "r": 10, "paint": {"color": \#(BLACK), "blur": 40}}]"#)
    ok("big blur centre partly clear", big.alpha(50, 50) < 200 && big.alpha(50, 50) > 0, "\(big.alpha(50, 50))")
    let s = Bitmap(#"[{"type": "line", "x1": 10, "y1": 50, "x2": 90, "y2": 50, "paint": {"style": "stroke", "strokeWidth": 6, "color": \#(BLACK), "blur": 3}}]"#)
    ok("blurred stroke soft above", s.alpha(50, 56) > 0 && s.alpha(50, 56) < 200, "\(s.alpha(50, 56))")
}

do {  // text: baseline at y, centre align is centred, paragraph maxLines with no ink below
    let t = Bitmap(#"[{"type": "text", "text": "WWW", "x": 50, "y": 60, "options": {"fontSize": 20, "color": \#(BLACK), "align": "center"}}]"#)
    let cols = t.inkColumns(), rows = t.inkRows()
    ok("text drawn", !cols.isEmpty)
    if let l = cols.first, let r = cols.last {
        ok("centred", abs((l + r) / 2 - 50) <= 1, "\(l)...\(r)")
    }
    ok("baseline at 60", (rows.last ?? 0) <= 61 && (rows.last ?? 0) >= 58, "\(rows.last ?? -1)")
    ok("caps above baseline", (rows.first ?? 100) >= 40, "\(rows.first ?? -1)")
    let rt = Bitmap(#"[{"type": "text", "text": "WWW", "x": 100, "y": 60, "options": {"fontSize": 20, "color": \#(BLACK), "align": "right"}}]"#)
    ok("right align ends at x", (rt.inkColumns().last ?? 0) >= 97 && (rt.inkColumns().last ?? 0) <= 100, "\(rt.inkColumns().last ?? -1)")
    let long = String(repeating: "word ", count: 60)
    let json = #"[{"type": "paragraph", "text": "\#(long)", "x": 0, "y": 0, "width": 100, "options": {"fontSize": 10, "lineHeight": 15, "maxLines": 2, "color": \#(BLACK)}}]"#
    var lines = 0
    let p = Bitmap(json) { c in
        _ = c
    }
    let pr = p.inkRows()
    ok("paragraph: no ink below two lines", (pr.last ?? 100) < 31, "\(pr.last ?? -1)")
    ok("paragraph: two lines of ink", pr.contains { $0 > 15 && $0 < 30 } && pr.contains { $0 < 15 }, "\(pr)")
    // The made lines: 2, the second cut with "…".
    let c = znParseCanvasCommands(json)
    let ctx = CGContext(data: nil, width: 10, height: 10, bitsPerComponent: 8, bytesPerRow: 40,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    znDrawCanvas(ctx, c, size: CGSize(width: 10, height: 10), base: .identity)
    if let op = c.ops.first as? ZnCanvasOp.Paragraph, let made = op.made {
        let m = Mirror(reflecting: made).children.first { $0.label == "lines" }?.value as? [(line: CTLine, dx: CGFloat, baseline: CGFloat)]
        lines = m?.count ?? -1
        if let last = m?.last?.line {
            let runs = CTLineGetGlyphRuns(last) as? [CTRun] ?? []
            let range = CTLineGetStringRange(last)
            ok("last line short", range.length < long.count, "\(range.length)")
            ok("last line has runs", !runs.isEmpty)
        }
        check("paragraph baselines 15 apart", (m?[1].baseline ?? 0) - (m?[0].baseline ?? 0), 15)
    }
    check("paragraph lines", lines, 2)
    // Centred paragraph line.
    let cp = Bitmap(#"[{"type": "paragraph", "text": "Paid", "x": 0, "y": 10, "width": 100, "options": {"fontSize": 16, "align": "center", "color": \#(BLACK)}}]"#)
    if let l = cp.inkColumns().first, let r = cp.inkColumns().last { ok("paragraph centred", abs((l + r) / 2 - 50) <= 1, "\(l)...\(r)") }
    // Rotated text turns with the canvas.
    let rot = Bitmap(#"[{"type": "translate", "dx": 50, "dy": 50}, {"type": "rotate", "degrees": 90}, {"type": "text", "text": "IIIIIIII", "x": 0, "y": 0, "options": {"fontSize": 12, "color": \#(BLACK)}}]"#)
    let rr = rot.inkRows(), rc = rot.inkColumns()
    ok("rotated text runs down", (rr.last ?? 0) - (rr.first ?? 0) > (rc.last ?? 0) - (rc.first ?? 0), "rows \(rr.first ?? -1)...\(rr.last ?? -1) cols \(rc.first ?? -1)...\(rc.last ?? -1)")
}

/// A 4 × 2 picture: columns red, green, green, blue.
func stripes() -> CGImage {
    let c = CGContext(data: nil, width: 4, height: 2, bitsPerComponent: 8, bytesPerRow: 16,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    for (i, col) in [RED, GREEN, GREEN, BLUE].enumerated() {
        c.setFillColor(CGColor(srgbRed: CGFloat(col >> 16 & 0xFF) / 255, green: CGFloat(col >> 8 & 0xFF) / 255, blue: CGFloat(col & 0xFF) / 255, alpha: 1))
        c.fill(CGRect(x: i, y: 0, width: 1, height: 2))
    }
    return c.makeImage()!
}

do {  // images: cover shows the middle, contain letterboxes, fill stretches, radius rounds, opacity
    let img = stripes()
    let set: (ZnCanvasCommands) -> Void = { c in for op in c.ops { (op as? ZnCanvasOp.Image)?.image = img } }
    let cover = Bitmap(#"[{"type": "image", "src": "a", "x": 0, "y": 0, "w": 40, "h": 40, "options": {"fit": "cover"}}]"#, setup: set)
    ok("cover: the middle columns", near(cover.at(10, 20), 0, 255, 0, by: 40) && near(cover.at(30, 20), 0, 255, 0, by: 40), "\(cover.at(10, 20)) \(cover.at(30, 20))")
    check("cover: only the box", cover.alpha(45, 20), 0)
    let contain = Bitmap(#"[{"type": "image", "src": "a", "x": 0, "y": 0, "w": 40, "h": 40, "options": {"fit": "contain"}}]"#, setup: set)
    check("contain: letterbox top clear", contain.alpha(20, 5), 0)
    check("contain: letterbox bottom clear", contain.alpha(20, 35), 0)
    ok("contain: red at the left", near(contain.at(2, 20), 255, 0, 0, by: 40), "\(contain.at(2, 20))")
    let fill = Bitmap(#"[{"type": "image", "src": "a", "x": 0, "y": 0, "w": 40, "h": 40, "options": {"fit": "fill"}}]"#, setup: set)
    ok("fill: red left, blue right, all rows", near(fill.at(2, 2), 255, 0, 0, by: 40) && near(fill.at(37, 37), 0, 0, 255, by: 40), "\(fill.at(2, 2)) \(fill.at(37, 37))")
    let round = Bitmap(#"[{"type": "image", "src": "a", "x": 0, "y": 0, "w": 40, "h": 40, "options": {"fit": "fill", "radius": 20, "opacity": 0.5}}]"#, setup: set)
    check("radius: corner clear", round.alpha(1, 1), 0)
    ok("opacity half", abs(round.alpha(20, 20) - 128) <= 2, "\(round.alpha(20, 20))")
    let none = Bitmap(#"[{"type": "image", "src": "a", "x": 0, "y": 0, "w": 40, "h": 40}]"#)
    check("not loaded: nothing", none.inkRows(), [])
}

do {  // decode: at most the asked size, covering it, never above the picture's own
    let ctx = CGContext(data: nil, width: 400, height: 200, bitsPerComponent: 8, bytesPerRow: 1600,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 200))
    let data = NSMutableData()
    if let img = ctx.makeImage(), let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil) {
        CGImageDestinationAddImage(dest, img, nil)
        CGImageDestinationFinalize(dest)
    }
    let small = znCanvasDecode(data as Data, 100, 100)
    check("decode covers 100 × 100", small.map { [$0.width, $0.height] }, [200, 100])
    let big = znCanvasDecode(data as Data, 4000, 4000)
    check("decode never upscales", big.map { [$0.width, $0.height] }, [400, 200])
    check("not a picture", znCanvasDecode(Data("nope".utf8), 10, 10) == nil, true)
}

print("\(count - failures)/\(count) passed")
exit(failures == 0 ? 0 : 1)
