// iOS's <Canvas> parser and drawing (ZnCanvasParse.swift, ZnCanvasDraw.swift, ZnPathData.swift), on the Mac:
// tools/ios-unit-test.ts builds this with the files in sources.txt. The parse cases are android/runtime's
// ZnCanvasTest.kt, with the same JSON and answers (motion values are the real engine's, ZnMotionEngine.swift). The draw
// cases render small lists into a 100 × 100 bitmap, flipped to UIKit's y-down, and look at pixels.
import CoreGraphics
import CoreText
import ImageIO
import Foundation
import Observation

/// ZnModules.swift's error (it needs the host, so it isn't built here).
struct ZnInvalidArgs: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

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
    // A weight too big for an Int is clamped, not a crash (Kotlin's toInt() saturates).
    let huge = parse(#"[{"type":"text","text":"a","x":0,"y":10,"options":{"fontWeight":1e30}}, {"type":"text","text":"a","x":0,"y":10,"options":{"fontWeight":-1e30}}]"#)
    check("huge weight", huge.ops.map { ($0 as? ZnCanvasOp.Text)?.fontWeight }, [1000, 1])
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

// ---- Motion values in commands (ZnCanvasTest.kt C1): sources from the motion engine, read on each draw -----------

let engine = ZnMotionEngine.shared

do {  // numbersFollowMotionValuesAndConstantsStayAsTheyWere
    let v = try! engine.putValue(5101, 10)
    defer { engine.dispose(5101) }
    let p = parse(#"[{"type": "rect", "x": "\u0000m5101", "y": 4, "w": 10, "h": 10}, {"type": "arc", "x": 0, "y": 0, "w": 10, "h": 10, "start": -90, "sweep": "\u0000m5101"}]"#, 2)
    check("follow errors", p.errors, [])
    check("follow moving", p.moving, true)
    check("follow missed", p.missed, false)
    let rect = p.ops[0] as? ZnCanvasOp.Rect
    ok("follow x has a source", rect?.x.src != nil)
    ok("follow y is a constant", rect?.y.src == nil)
    check("follow x now", rect?.x.value, 20)  // dp × density, read now
    check("follow y", rect?.y.value, 8)
    v.value = 30
    check("follow x moved", rect?.x.value, 60)  // the same op reads the new value: no new parse
    let arc = p.ops[1] as? ZnCanvasOp.Arc
    check("follow sweep in degrees", arc?.sweep.value, 30)  // not scaled by density
    check("follow start", arc?.start.value, -90)
    check("constant list not moving", parse(#"[{"type": "rect", "x": 1, "y": 4, "w": 10, "h": 10}]"#).moving, false)
}

do {  // aMotionValueThatIsGoneDrawsAsZeroWithAWarning
    let p = parse(#"[{"type": "circle", "cx": "\u0000m987654", "cy": 5, "r": 5}]"#)
    check("gone count", p.ops.count, 1)
    check("gone value", (p.ops.first as? ZnCanvasOp.Circle)?.cx.value, 0)
    check("gone error", p.errors, ["command 0: \"cx\" follows motion value 987654, which is gone; 0 is used"])
    check("gone missed", p.missed, true)
    check("gone not moving", p.moving, false)
}

do {  // paintOpacityStrokeWidthAndColourFollowMotionValues
    let v = try! engine.putValue(5102, 0.5)
    try! engine.put(5103, ZnColorMapSource(id: 5103, v, [0, 1], [0xFFFF_0000, 0xFF00_00FF]))
    defer { engine.dispose(5102); engine.dispose(5103) }
    let p = parse("""
    [{"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0,
      "paint": {"style": "stroke", "strokeWidth": "\\u0000m5102", "opacity": "\\u0000m5102", "color": "\\u0000m5103"}}]
    """, 2)
    check("paint follow errors", p.errors, [])
    let paint = (p.ops.first as? ZnCanvasOp.Line)?.paint
    check("paint alpha", paint?.alpha(), 0.5)
    check("paint width", paint?.width(), 1)  // 0.5 dp × 2
    v.value = 0
    check("paint colour red", paint?.color.value, RED)
    check("paint width minimum", paint?.width(), 1)  // 0: the 1 px minimum
    v.value = 3
    check("paint alpha clamped", paint?.alpha(), 1)
    check("paint width moved", paint?.width(), 6)
    v.value = 1
    check("paint colour blue", paint?.color.value, BLUE)
}

do {  // aNumberMotionValueAsAColourIsBlackWithAWarning
    _ = try! engine.putValue(5104, 1)
    defer { engine.dispose(5104) }
    let p = parse(#"[{"type": "text", "text": "a", "x": 0, "y": 10, "options": {"color": "\u0000m5104"}}]"#)
    check("number as colour black", (p.ops.first as? ZnCanvasOp.Text)?.color.value, BLACK)
    check("number as colour errors", p.errors, ["command 0: color follows a number, not a colour (use v.mapColor(...)); black is used"])
    // One that is gone: black too.
    let gone = parse(#"[{"type": "text", "text": "a", "x": 0, "y": 10, "options": {"color": "\u0000m987655"}}]"#)
    check("gone colour black", (gone.ops.first as? ZnCanvasOp.Text)?.color.value, BLACK)
    check("gone colour errors", gone.errors.count, 1)
}

do {  // aMotionValueWhereNoneIsAllowedSkipsTheCommand
    _ = try! engine.putValue(5105, 1)
    defer { engine.dispose(5105) }
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

do {  // pathTrimsParse
    let v = try! engine.putValue(5106, 0.25)
    defer { engine.dispose(5106) }
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
    check("trimEnd", t?.trimEnd?.value, 0.25)  // a fraction: not scaled by density
    check("trimStart", t?.trimStart?.value, 0)
    ok("no trimOffset", t?.trimOffset == nil)
    check("untrimmed", (p.ops[1] as? ZnCanvasOp.PathOp)?.trimmed, false)
    check("trims errors", p.errors.count, 1)
    v.value = 0.75
    check("trimEnd moved", t?.trimEnd?.value, 0.75)
}

do {  // a disposed value keeps its last value (a screen's exit draws on), and a new one under the id wins
    let v = try! engine.putValue(5107, 7)
    let p = parse(#"[{"type": "circle", "cx": "\u0000m5107", "cy": 5, "r": 5}]"#)
    engine.dispose(5107)
    check("disposed keeps its value", (p.ops.first as? ZnCanvasOp.Circle)?.cx.value, 7)
    let again = parse(#"[{"type": "circle", "cx": "\u0000m5107", "cy": 5, "r": 5}]"#)
    check("disposed still found", again.errors, [])
    _ = try! engine.putValue(5107, 9)
    defer { engine.dispose(5107) }
    check("new one under the id", (parse(#"[{"type": "circle", "cx": "\u0000m5107", "cy": 5, "r": 5}]"#).ops.first as? ZnCanvasOp.Circle)?.cx.value, 9)
    _ = v
}

do {  // a moving image size is decoded at the screen's longer side (Android's rule), a fixed one at its own
    _ = try! engine.putValue(5108, 40)
    defer { engine.dispose(5108) }
    let p = znParseCanvasCommands(#"[{"type": "image", "src": "a", "x": 0, "y": 0, "w": "\u0000m5108", "h": 40}, {"type": "image", "src": "a", "x": 0, "y": 0, "w": 40, "h": 40}]"#,
                                  density: 1, pixels: 3, screen: 2556)
    let moving = p.ops[0] as? ZnCanvasOp.Image, fixed = p.ops[1] as? ZnCanvasOp.Image
    check("moving decode", moving.map { [$0.decodeW, $0.decodeH] }, [2556, 2556])
    check("fixed decode", fixed.map { [$0.decodeW, $0.decodeH] }, [120, 120])
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
    // After Z: numbers are dropped (Compose), anything else stops the data. These looped forever before 2026-11-21.
    let z = ZnPathData.parse("M0 0 L10 0 L10 10 Z 5 5 M 20 20 L 30 20")
    check("numbers after Z dropped", z.ok, true)
    check("path after Z numbers", z.path.currentPoint, CGPoint(x: 30, y: 20))
    check("number packed after Z", ZnPathData.parse("M0 0 L10 0 Z1").ok, true)
    check("dot after Z", ZnPathData.parse("M0 0 L10 0 Z .").ok, false)
    check("hash after Z", ZnPathData.parse("M0 0 L10 0 Z#").ok, false)
    check("z then relative move", ZnPathData.parse("M 10 10 h 10 z 3 m 1 1").path.currentPoint, CGPoint(x: 11, y: 11))
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
        ctx = Bitmap.context(w, h, background)
        let c = znParseCanvasCommands(json)
        if !c.errors.isEmpty { print("note: \(c.errors)") }
        setup?(c)
        znDrawCanvas(ctx, c, size: CGSize(width: w, height: h), base: .identity)
    }

    /// [c] (parsed already) drawn, at [scale] device pixels per unit (a screen's 3×: base space is still the bitmap's).
    init(commands c: ZnCanvasCommands, w: Int = 100, h: Int = 100, scale: CGFloat = 1) {
        self.w = w
        self.h = h
        ctx = Bitmap.context(w, h, nil)
        ctx.scaleBy(x: scale, y: scale)
        znDrawCanvas(ctx, c, size: CGSize(width: CGFloat(w) / scale, height: CGFloat(h) / scale), base: .identity)
    }

    /// y down like UIKit's.
    private static func context(_ w: Int, _ h: Int, _ background: UInt32?) -> CGContext {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        if let background {
            ctx.setFillColor(CGColor(srgbRed: CGFloat(background >> 16 & 0xFF) / 255, green: CGFloat(background >> 8 & 0xFF) / 255,
                                     blue: CGFloat(background & 0xFF) / 255, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        return ctx
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

// ---- Drawing: motion values and blurred gradients ------------------------------------------------------------------

/// What an Observation onChange counts (it may run on any thread; here it runs on this one).
final class Counter: @unchecked Sendable {
    var n = 0
}

do {  // one parsed list drawn twice: the rect moves with its value, nothing is parsed again
    let v = try! engine.putValue(5201, 10)
    defer { engine.dispose(5201) }
    let c = parse(#"[{"type": "rect", "x": "\u0000m5201", "y": 40, "w": 20, "h": 20, "paint": {"color": \#(RED)}}]"#)
    let a = Bitmap(commands: c)
    check("moving rect at 10", a.inkColumns().first, 10)
    v.value = 60
    let b = Bitmap(commands: c)
    check("moving rect at 60", b.inkColumns().first, 60)
    check("moving rect width", b.inkColumns().count, 20)
}

do {  // ZnCanvas.View's redraw: a draw tracked with Observation hears a value it read, not one it didn't
    let v = try! engine.putValue(5202, 0)
    let other = try! engine.putValue(5203, 0)
    let colour = try! engine.putValue(5204, 0)
    try! engine.put(5205, ZnColorMapSource(id: 5205, colour, [0, 1], [RED, BLUE]))
    defer { for id in 5202...5205 { engine.dispose(id) } }
    let c = parse(#"[{"type": "arc", "x": 10, "y": 10, "w": 80, "h": 80, "start": -90, "sweep": "\u0000m5202", "useCenter": true, "paint": {"color": "\u0000m5205"}}]"#)
    let heard = Counter()
    func tracked() -> Bitmap {
        var out: Bitmap?
        withObservationTracking { out = Bitmap(commands: c) } onChange: { heard.n += 1 }
        return out!
    }
    let empty = tracked()
    check("sweep 0 draws nothing", empty.inkRows(), [])
    other.value = 5
    check("a value it didn't read: no redraw", heard.n, 0)
    v.value = 90
    check("its value moved: one redraw", heard.n, 1)
    v.value = 180
    check("once per draw (the next draw tracks again)", heard.n, 1)
    let half = tracked()
    ok("half the circle (right side) drawn", half.alpha(70, 50) == 255 && half.alpha(30, 50) == 0, "\(half.alpha(70, 50)) \(half.alpha(30, 50))")
    ok("red at 0", near(half.at(70, 50), 255, 0, 0), "\(half.at(70, 50))")
    colour.value = 1
    check("its colour moved: a redraw", heard.n, 2)
    let blue = tracked()
    ok("blue at 1", near(blue.at(70, 50), 0, 0, 255), "\(blue.at(70, 50))")
    // A list with no motion values reads nothing: nothing to hear.
    let heardStatic = Counter()
    withObservationTracking { _ = Bitmap(#"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10}]"#) } onChange: { heardStatic.n += 1 }
    v.value = 270
    colour.value = 0
    check("a static list hears nothing", heardStatic.n, 0)
}

do {  // a moving path trim draws more as it grows
    let t = try! engine.putValue(5206, 0.25)
    defer { engine.dispose(5206) }
    let c = parse(#"[{"type": "path", "d": "M10 50 L90 50", "trimEnd": "\u0000m5206", "paint": {"style": "stroke", "strokeWidth": 4, "color": \#(BLACK)}}]"#)
    check("trim a quarter", Bitmap(commands: c).inkColumns().count, 20)
    t.value = 1
    check("trim all", Bitmap(commands: c).inkColumns().count, 80)
}

do {  // blur on gradients (BlurMaskFilter with a shader): soft, the gradient's colours kept, nothing sharp
    let r = Bitmap(#"[{"type": "circle", "cx": 50, "cy": 50, "r": 20, "paint": {"radialGradient": {"cx": 50, "cy": 50, "r": 20, "colors": [\#(RED), \#(BLUE)]}, "blur": 10}}]"#)
    let centre = r.at(50, 50), edge = r.alpha(70, 50), out = r.alpha(80, 50)
    ok("radial blur centre mostly red", centre.a > 150 && centre.r > centre.b, "\(centre)")
    ok("radial blur edge half", edge > 50 && edge < 200, "\(edge)")
    ok("radial blur outside soft", out > 3 && out < 100, "\(out)")
    check("radial blur nothing at the far edge", r.alpha(99, 50), 0)
    // The same circle sharp has a hard edge: blur is really on.
    let sharp = Bitmap(#"[{"type": "circle", "cx": 50, "cy": 50, "r": 20, "paint": {"radialGradient": {"cx": 50, "cy": 50, "r": 20, "colors": [\#(RED), \#(BLUE)]}}}]"#)
    check("sharp outside", sharp.alpha(80, 50), 0)
    // A sweep ring (stroke) blurred: soft on both sides of the stroke.
    let s = Bitmap(#"[{"type": "circle", "cx": 50, "cy": 50, "r": 30, "paint": {"style": "stroke", "strokeWidth": 6, "sweepGradient": {"cx": 50, "cy": 50, "colors": [\#(RED), \#(BLUE)], "startAngle": -90}, "blur": 4}}]"#)
    let inner = s.alpha(50, 26), outer = s.alpha(50, 14), ring = s.alpha(50, 20)
    ok("sweep blur ring", ring > 120, "\(ring)")
    ok("sweep blur soft inside", inner > 0 && inner < 120, "\(inner)")
    ok("sweep blur soft outside", outer > 0 && outer < 120, "\(outer)")
    ok("sweep blur keeps its colours", s.at(53, 20).r > s.at(53, 20).b && s.at(47, 20).b > s.at(47, 20).r, "\(s.at(53, 20)) \(s.at(47, 20))")
    check("sweep blur centre clear", s.alpha(50, 50), 0)
    // Opacity applies to the blurred shape.
    let half = Bitmap(#"[{"type": "rect", "x": 20, "y": 20, "w": 60, "h": 60, "paint": {"opacity": 0.5, "linearGradient": {"x0": 20, "y0": 0, "x1": 80, "y1": 0, "colors": [\#(RED), \#(BLUE)]}, "blur": 3}}]"#)
    ok("blur opacity", abs(half.alpha(50, 50) - 128) < 8, "\(half.alpha(50, 50))")
    // A clip still cuts it.
    let clipped = Bitmap(#"[{"type": "clipRect", "x": 0, "y": 0, "w": 50, "h": 100}, {"type": "rect", "x": 20, "y": 20, "w": 60, "h": 60, "paint": {"linearGradient": {"x0": 20, "y0": 0, "x1": 80, "y1": 0, "colors": [\#(RED), \#(BLUE)]}, "blur": 3}}]"#)
    check("blur clipped", clipped.inkColumns().last, 49)
    ok("blur clipped soft at its own edge", clipped.alpha(20, 50) > 50 && clipped.alpha(20, 50) < 200, "\(clipped.alpha(20, 50))")
}

do {  // blur radius is in the canvas's space: scale(2) blurs twice as far; a 3× screen the same as 1× in points
    func spread(_ json: String, scale: CGFloat = 1) -> Int {
        let b = Bitmap(commands: parse(json), w: Int(100 * scale), h: Int(100 * scale), scale: scale)
        return Int((CGFloat(b.inkColumns().count) / scale).rounded())
    }
    let g = #""linearGradient": {"x0": 0, "y0": 0, "x1": 100, "y1": 0, "colors": [\#(RED), \#(BLUE)]}"#
    let one = spread(#"[{"type": "rect", "x": 45, "y": 45, "w": 10, "h": 10, "paint": {\#(g), "blur": 4}}]"#)
    let two = spread(#"[{"type": "scale", "sx": 2}, {"type": "rect", "x": 22.5, "y": 22.5, "w": 5, "h": 5, "paint": {\#(g), "blur": 4}}]"#)
    let three = spread(#"[{"type": "rect", "x": 45, "y": 45, "w": 10, "h": 10, "paint": {\#(g), "blur": 4}}]"#, scale: 3)
    ok("scaled blur spreads further", two > one + 4, "\(one) \(two)")
    ok("3× screen spreads the same in points", abs(three - one) <= 2, "\(one) \(three)")
    // Same spread as the solid blur (one sigma rule for both).
    let solid = spread(#"[{"type": "rect", "x": 45, "y": 45, "w": 10, "h": 10, "paint": {"color": \#(RED), "blur": 4}}]"#)
    ok("gradient blur spreads as the solid one", abs(solid - one) <= 2, "\(solid) \(one)")
}

do {  // ZnCanvasWatch (the view's redraw): one watch at a time, however often it draws while its values sit still
    let x = try! engine.putValue(5208, 10)
    let other = try! engine.putValue(5209, 0)
    defer { engine.dispose(5208); engine.dispose(5209) }
    let heard = Counter()
    let watch = ZnCanvasWatch { heard.n += 1 }
    func list(_ w: Int) -> ZnCanvasCommands {
        parse(#"[{"type": "rect", "x": "\u0000m5208", "y": 0, "w": \#(w), "h": 10, "paint": {"color": \#(BLACK)}}]"#)
    }
    let a = list(10)
    check("list sources", a.sources.map(\.id), [5208])
    var drew = 0
    for _ in 0..<100 { watch.draw(a) { drew += 1 } }
    check("100 draws, all run", drew, 100)
    check("100 draws, one watch", watch.started, 1)
    // A new list (a chart's every 500 ms) that reads the same values keeps the watch.
    for w in 0..<50 { watch.draw(list(11 + w)) {} }
    check("new lists, same values: still one watch", watch.started, 1)
    x.value = 20
    check("one change: heard once", heard.n, 1)
    x.value = 30
    check("before the next draw: not again", heard.n, 1)
    watch.draw(a) {}
    check("the next draw watches again", watch.started, 2)
    x.value = 40
    check("and hears the next change", heard.n, 2)
    // A list with other values: a new watch, and the old one's change is dropped.
    watch.draw(a) {}
    let b = parse(#"[{"type": "rect", "x": "\u0000m5209", "y": 0, "w": 10, "h": 10, "paint": {"color": \#(BLACK)}}]"#)
    watch.draw(b) {}
    check("other values: a new watch", watch.started, 4)
    x.value = 50
    check("the old list's value: dropped", heard.n, 2)
    other.value = 1
    check("the new list's value: heard", heard.n, 3)
    // A list that stops moving: the watch still on is ignored.
    watch.draw(a) {}
    watch.draw(list(10)) {}
    watch.draw(parse(#"[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10}]"#)) {}
    x.value = 60
    check("a still list: nothing heard", heard.n, 3)
    // Every source of the list is watched, not only what the draw read.
    let c = parse(#"[{"type": "rect", "x": "\u0000m5208", "y": "\u0000m5209", "w": 10, "h": 10, "paint": {"color": \#(BLACK)}}]"#)
    watch.draw(c) {}  // reads nothing itself
    other.value = 2
    check("a source the draw didn't reach: heard", heard.n, 4)
}

do {  // a blurred stroked gradient keeps its miter tips (they reach past the stroke's width before the blur)
    // A V of 20-wide strokes, apex at y 60: the miter tip reaches about 35 above it (y 25), past the width (20).
    let v = Bitmap(#"[{"type": "path", "d": "M38 100 L50 60 L62 100", "paint": {"style": "stroke", "strokeWidth": 20, "linearGradient": {"x0": 0, "y0": 0, "x1": 100, "y1": 0, "colors": [\#(RED), \#(BLUE)]}, "blur": 0.5}}]"#)
    ok("miter tip drawn", v.alpha(50, 33) > 200, "\(v.alpha(50, 33))")
    ok("miter tip ends near its point", v.alpha(50, 21) < 60, "\(v.alpha(50, 21))")
}

do {  // a blurred vertical gradient stays the right way up (red at the top, y down as UIKit)
    let g = Bitmap(#"[{"type": "rect", "x": 20, "y": 10, "w": 60, "h": 80, "paint": {"linearGradient": {"x0": 0, "y0": 10, "x1": 0, "y1": 90, "colors": [\#(RED), \#(BLUE)]}, "blur": 4}}]"#)
    let top = g.at(50, 20), bottom = g.at(50, 80)
    ok("blurred vertical gradient: red at the top", top.r > 150 && top.r > top.b + 100, "\(top)")
    ok("blurred vertical gradient: blue at the bottom", bottom.b > 150 && bottom.b > bottom.r + 100, "\(bottom)")
    // Its shape too: soft at the top edge, sharp nowhere, nothing far above.
    ok("blurred vertical gradient soft at its top", g.alpha(50, 10) > 50 && g.alpha(50, 10) < 200, "\(g.alpha(50, 10))")
    check("nothing far above", g.alpha(50, 0), 0)
    // The same with a turn of 90° (device y from user x): red still where the gradient starts.
    let t = Bitmap(#"[{"type": "rotate", "degrees": 90, "px": 50, "py": 50}, {"type": "rect", "x": 10, "y": 30, "w": 80, "h": 40, "paint": {"linearGradient": {"x0": 10, "y0": 0, "x1": 90, "y1": 0, "colors": [\#(RED), \#(BLUE)]}, "blur": 3}}]"#)
    let t1 = t.at(50, 20), t2 = t.at(50, 80)
    ok("turned blurred gradient: red at the top", t1.r > t1.b + 100, "\(t1)")
    ok("turned blurred gradient: blue at the bottom", t2.b > t2.r + 100, "\(t2)")
}

do {  // per-frame cost of a moving canvas (tiles 10 and 11 at 3×), on this Mac: printed, with a loose bound
    let v = try! engine.putValue(5207, 0)
    defer { engine.dispose(5207) }
    let ring = parse(#"""
    [{"type": "circle", "cx": 80, "cy": 80, "r": 60, "paint": {"style": "stroke", "strokeWidth": 14, "color": 4293258476}},
     {"type": "arc", "x": 20, "y": 20, "w": 120, "h": 120, "start": -90, "sweep": "\u0000m5207", "paint": {"style": "stroke", "strokeWidth": 14, "strokeCap": "round", "color": 4282339839}}]
    """#)
    let glow = parse(#"[{"type": "circle", "cx": 80, "cy": 80, "r": "\u0000m5207", "paint": {"radialGradient": {"cx": 80, "cy": 80, "r": 50, "colors": [\#(RED), \#(BLUE)]}, "blur": 8}}]"#)
    // One 480 × 480 bitmap cleared before each draw, as a view's backing store is.
    let ctx = CGContext(data: nil, width: 480, height: 480, bitsPerComponent: 8, bytesPerRow: 480 * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: 480)
    ctx.scaleBy(x: 3, y: -3)
    func time(_ c: ZnCanvasCommands, _ n: Int, _ value: (Int) -> Float) -> Double {
        let t0 = CFAbsoluteTimeGetCurrent()
        for i in 0..<n {
            v.value = value(i)
            ctx.clear(CGRect(x: 0, y: 0, width: 160, height: 160))
            znDrawCanvas(ctx, c, size: CGSize(width: 160, height: 160), base: .identity)
        }
        return (CFAbsoluteTimeGetCurrent() - t0) / Double(n) * 1000
    }
    let ringMs = time(ring, 120) { Float($0 * 3) }
    let glowMs = time(glow, 60) { Float(10 + $0 % 40) }
    print(String(format: "note: a moving ring at 3× (480 × 480 px): %.2f ms a draw; a moving blurred gradient: %.2f ms", ringMs, glowMs))
    ok("moving ring under a frame", ringMs < 16, "\(ringMs) ms")
}

print("\(count - failures)/\(count) passed")
exit(failures == 0 ? 0 : 1)
