// iOS's parsers for template values read before they are drawn, on the Mac: tools/ios-spec-test.ts builds this with
// ZnListLogic.swift and ZnScrollCommand.swift (Foundation only). The cases follow android/runtime: ZnTemplate.kt's
// ZnColumnWrapper.parse (strings as compiler/test/list-grid.test.ts writes them), ZnRenderer.kt's parseSticky, and the
// scroll command reading in ZnRenderer.kt (List) and ZnScrollExtras.kt (Scroll), with core's bindListController texts.
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

// columnWrapperStyle: "g<gap>;j<justify>;a<align>;p<start>,<top>,<end>,<bottom>".
check("wrapper gap + paddingHorizontal", ZnColumnWrapper.parse("g12;j-1;a-1;p16,0,16,0"),
      ZnColumnWrapper(gap: 12, justify: -1, align: -1, start: 16, top: 0, end: 16, bottom: 0))
check("wrapper all parts", ZnColumnWrapper.parse("g8;j3;a1;p4,10,4,4"),
      ZnColumnWrapper(gap: 8, justify: 3, align: 1, start: 4, top: 10, end: 4, bottom: 4))
check("wrapper start / end", ZnColumnWrapper.parse("g0;j-1;a-1;p6,0,2,0"), ZnColumnWrapper(start: 6, end: 2))
check("wrapper nil", ZnColumnWrapper.parse(nil), .none)
check("wrapper empty", ZnColumnWrapper.parse(""), .none)
check("wrapper garbage keeps defaults", ZnColumnWrapper.parse("gx;jy;az;p1,2,3;q9;;"), .none)
check("wrapper negative gap is 0", ZnColumnWrapper.parse("g-4;j1"), ZnColumnWrapper(justify: 1))
check("wrapper NaN gap is 0", ZnColumnWrapper.parse("gNaN"), .none)
check("wrapper fractional", ZnColumnWrapper.parse("g2.5;p0.5,1,1.5,2"),
      ZnColumnWrapper(gap: 2.5, start: 0.5, top: 1, end: 1.5, bottom: 2))
check("wrapper bad padding part drops the padding", ZnColumnWrapper.parse("p1,x,3,4"), .none)

// stickyHeaderIndices: sorted, distinct, bad and negative entries dropped.
check("sticky", znParseSticky("30, 1,1,x,-2"), [1, 30])
check("sticky nil", znParseSticky(nil), [])
check("sticky empty", znParseSticky(""), [])

// Scroll commands: "action:param:animated:second:seq".
let idx = ZnScrollCommand("index:15:1:0:3")
check("index action", idx?.action, .index)
check("index param", idx?.param, 15)
check("index animated", idx?.animated, true)
check("index seq", idx?.seq, 3)
let off = ZnScrollCommand("index:4:0:2.5:7")
check("viewOffset", off?.second, 2.5)
check("not animated", off?.animated, false)
check("end", ZnScrollCommand("end:0:0:0:4")?.action, .end)
check("bad number is 0", ZnScrollCommand("offset:abc:1:0:5")?.param, 0)
check("NaN is 0", ZnScrollCommand("offset:NaN:1:0:5")?.param, 0)
check("Infinity is 0", ZnScrollCommand("to:Infinity:1:-Infinity:5")?.second, 0)
check("no seq", ZnScrollCommand("index:1:1:0") == nil, true)
check("bad seq", ZnScrollCommand("index:1:1:0:x") == nil, true)
check("fractional seq", ZnScrollCommand("index:1:1:0:2.5") == nil, true)
check("nil text", ZnScrollCommand(nil) == nil, true)
check("unknown action keeps its seq", ZnScrollCommand("zoom:1:1:0:9").map { [$0.action == .other ? 1 : 0, $0.seq] }, [1, 9])
check("anything but 0 animates", ZnScrollCommand("end:0:true:0:1")?.animated, true)
// Along the axis: offset takes param; to takes x sideways, y downwards; index and end have none.
check("offset axis", ZnScrollCommand("offset:120:1:0:1")?.axisOffset(horizontal: false), 120)
check("to vertical", ZnScrollCommand("to:10:1:300:1")?.axisOffset(horizontal: false), 300)
check("to horizontal", ZnScrollCommand("to:10:1:300:1")?.axisOffset(horizontal: true), 10)
check("index no axis", ZnScrollCommand("index:3:1:0:1")?.axisOffset(horizontal: false) == nil, true)
// Each seq runs once: a List starts at -1 (seq 0 can't come from core, but a first command runs), a Scroll at 0.
check("new after -1", ZnScrollCommand("end:0:1:0:1")!.isNew(after: -1), true)
check("same seq is old", ZnScrollCommand("end:0:1:0:4")!.isNew(after: 4), false)
check("older seq is old", ZnScrollCommand("end:0:1:0:3")!.isNew(after: 4), false)

print(failures == 0 ? "ios spec parsers: \(count) checks passed" : "ios spec parsers: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
