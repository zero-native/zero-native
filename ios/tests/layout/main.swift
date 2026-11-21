// iOS's readers for layout values from a slot (ZnDynamicValues.swift), on the Mac: tools/ios-layout-test.ts builds this
// with Registry.swift and Readers.swift. The cases follow android/runtime's ZnRenderer.kt (resolveSizePx, finiteNum,
// the dynamic shape's corner order, displayNone) and ZnTouch.kt (pointerEventsOf).
import CoreGraphics
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

// Sizes: a number is points, "NN%" a fraction, "auto" / other text / NaN / null not written.
check("number", znSizeValue(.number(120)), .points(120))
check("50%", znSizeValue(.string("50%")), .percent(0.5))
check(" 33.5 % ", znSizeValue(.string(" 33.5 % ")), .percent(0.335))
check("template percent", znSizeValue(.percent(0.25)), .percent(0.25))
check("negative %", znSizeValue(.string("-10%")), .percent(0))
check("auto", znSizeValue(.string("auto")), nil)
check("junk", znSizeValue(.string("wide")), nil)
check("NaN", znSizeValue(.number(.nan)), nil)
check("Infinity", znSizeValue(.number(.infinity)), nil)
check("null", znSizeValue(.null), nil)
check("bool", znSizeValue(.bool(true)), nil)

// Numbers: only finite ones.
check("finite", znFinite(.number(8)), 8)
check("finite NaN", znFinite(.number(.nan)), nil)
check("finite -Infinity", znFinite(.number(-.infinity)), nil)
check("finite string", znFinite(.string("8")), nil)

// Corners (topStart, topEnd, bottomEnd, bottomStart): own slot > written static corner > borderRadius slot > static.
let fixed: [CGFloat] = [8, 4, 4, 4]  // borderRadius 4, borderTopLeftRadius 8
let written = [true, false, false, false]
check("static only", znCorners(fixed: fixed, written: written, cornerSlots: [nil, nil, nil, nil], all: nil), [8, 4, 4, 4])
check("all from slot keeps a written corner", znCorners(fixed: fixed, written: written, cornerSlots: [nil, nil, nil, nil], all: 20),
      [8, 20, 20, 20])
check("corner slot beats all", znCorners(fixed: fixed, written: written, cornerSlots: [nil, 2, nil, nil], all: 20), [8, 2, 20, 20])
check("corner slot beats written", znCorners(fixed: fixed, written: written, cornerSlots: [30, nil, nil, nil], all: nil), [30, 4, 4, 4])
check("negative is 0", znCorners(fixed: [0, 0, 0, 0], written: [false, false, false, false], cornerSlots: [-5, nil, nil, nil], all: -1),
      [0, 0, 0, 0])

// pointerEvents strings; anything else is unset.
check("pe none", znPointerEvents(.string("none")), Registry.PointerEvents.none)
check("pe box-none", znPointerEvents(.string("box-none")), Registry.PointerEvents.boxNone)
check("pe box-only", znPointerEvents(.string("box-only")), Registry.PointerEvents.boxOnly)
check("pe auto", znPointerEvents(.string("auto")), Registry.PointerEvents.auto)
check("pe null", znPointerEvents(.null), znPointerEventsUnset)
check("pe junk", znPointerEvents(.string("all")), znPointerEventsUnset)

// display.
check("display none", znDisplayNone(.string("none")), true)
check("display 1", znDisplayNone(.number(1)), true)
check("display flex", znDisplayNone(.string("flex")), false)
check("display 0", znDisplayNone(.number(0)), false)
check("display null", znDisplayNone(.null), false)

print(failures == 0 ? "ios layout values: \(count) checks passed" : "ios layout values: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
