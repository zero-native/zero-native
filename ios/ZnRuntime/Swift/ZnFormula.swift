// A `derive(() => ...)` formula (Android: ZnFormula.kt, op for op; docs/gestures-and-motion-v1.md §2.4, D1). The
// compiler turns the TS expression into postfix tokens (compiler motion.ts); this checks them once when JS makes the
// formula and runs them where a binding reads them, on a fixed stack, with no allocation. Foundation only.
//
// Tokens: a number (a constant), "$k" (input k: a source or a constant JS passed), "sw" "sh" "pw" "ph" (the site's
// own / parent width and height), an operator or function name, "L<k>" (interpolate with table k), "C<k>"
// (interpolateColor with table k: only as the last token; the formula is then a colour).
//
// Limits (checked here, and by the compiler first): at most 64 tokens, a stack of at most 16 that never runs short,
// one value at the end, known inputs only. Inputs exist before the formula, so there are no cycles. x / 0 and x % 0
// are 0. A result that isn't finite is dropped by the source (its last good value stays).
//
// A formula's inputs read observed cells (ZnCell), so a SwiftUI body that reads a formula is redrawn when any value
// it depends on moves, as Compose's draw-phase reads are.
import Foundation

/// What "$k" reads.
enum ZnFormulaInput {
    case const(Float)
    case src(ZnSource)
}

final class ZnFormula {
    static let maxOps = 64
    static let maxStack = 16

    /// An interpolate table: inputs, outputs (numbers) or colours (ARGB), extrapolation.
    struct Table {
        let ins: [Float], outs: [Float], colors: [UInt32]?, ex: Int
    }

    private let ops: [Int32]
    private let args: [Int32]
    private let consts: [Float]
    private let inputs: [ZnFormulaInput]
    private let tables: [Table]
    let isColor: Bool
    let usesSite: Bool
    private let stack = UnsafeMutablePointer<Float>.allocate(capacity: ZnFormula.maxStack)

    private init(ops: [Int32], args: [Int32], consts: [Float], inputs: [ZnFormulaInput], tables: [Table], isColor: Bool,
                 usesSite: Bool) {
        self.ops = ops; self.args = args; self.consts = consts; self.inputs = inputs; self.tables = tables
        self.isColor = isColor; self.usesSite = usesSite
        stack.initialize(repeating: 0, count: Self.maxStack)
    }

    deinit { stack.deallocate() }

    func eval(_ site: ZnSite?) -> Float { isColor ? 0 : run(site, ops.count) }

    func evalColor(_ site: ZnSite?) -> UInt32 {
        guard isColor else { return 0 }
        // The last op is the colour table: run everything before it, then mix.
        let x = run(site, ops.count - 1)
        let t = tables[Int(args[ops.count - 1])]
        return znMixColors(x, t.ins, t.colors ?? [])
    }

    // Opcodes (the same numbers as ZnFormula.kt, so the two read alike).
    private static let CONST: Int32 = 0, INPUT: Int32 = 1, SELF_W: Int32 = 2, SELF_H: Int32 = 3, PARENT_W: Int32 = 4,
        PARENT_H: Int32 = 5, TABLE: Int32 = 6, COLOR_TABLE: Int32 = 7
    private static let ADD: Int32 = 10, SUB: Int32 = 11, MUL: Int32 = 12, DIV: Int32 = 13, MOD: Int32 = 14,
        NEG: Int32 = 15, LT: Int32 = 16, GT: Int32 = 17, LE: Int32 = 18, GE: Int32 = 19, EQ: Int32 = 20, NE: Int32 = 21,
        AND: Int32 = 22, OR: Int32 = 23, NOT: Int32 = 24, COND: Int32 = 25, MIN: Int32 = 26, MAX: Int32 = 27,
        ABS: Int32 = 28, FLOOR: Int32 = 29, CEIL: Int32 = 30, ROUND: Int32 = 31, SIGN: Int32 = 32, SQRT: Int32 = 33,
        POW: Int32 = 34, SIN: Int32 = 35, COS: Int32 = 36, TAN: Int32 = 37, ATAN2: Int32 = 38, HYPOT: Int32 = 39,
        EXP: Int32 = 40, LOG: Int32 = 41, CLAMP: Int32 = 42

    /// Operator name → (opcode, values it takes).
    private static let names: [String: (Int32, Int)] = [
        "+": (ADD, 2), "-": (SUB, 2), "*": (MUL, 2), "/": (DIV, 2), "%": (MOD, 2), "neg": (NEG, 1),
        "<": (LT, 2), ">": (GT, 2), "<=": (LE, 2), ">=": (GE, 2), "==": (EQ, 2), "!=": (NE, 2),
        "&&": (AND, 2), "||": (OR, 2), "!": (NOT, 1), "?": (COND, 3), "min": (MIN, 2), "max": (MAX, 2),
        "abs": (ABS, 1), "floor": (FLOOR, 1), "ceil": (CEIL, 1), "round": (ROUND, 1), "sign": (SIGN, 1),
        "sqrt": (SQRT, 1), "pow": (POW, 2), "sin": (SIN, 1), "cos": (COS, 1), "tan": (TAN, 1),
        "atan2": (ATAN2, 2), "hypot": (HYPOT, 2), "exp": (EXP, 1), "log": (LOG, 1), "clamp": (CLAMP, 3),
    ]

    private func run(_ site: ZnSite?, _ end: Int) -> Float {
        let s = stack
        var sp = 0
        for i in 0..<end {
            let a = Int(args[i])
            switch ops[i] {
            case Self.CONST: s[sp] = consts[a]; sp += 1
            case Self.INPUT:
                switch inputs[a] {
                case .const(let v): s[sp] = v
                case .src(let src): s[sp] = src.read(site)
                }
                sp += 1
            case Self.SELF_W: s[sp] = site?.selfW ?? 0; sp += 1
            case Self.SELF_H: s[sp] = site?.selfH ?? 0; sp += 1
            case Self.PARENT_W: s[sp] = site?.parentW ?? 0; sp += 1
            case Self.PARENT_H: s[sp] = site?.parentH ?? 0; sp += 1
            case Self.TABLE:
                let t = tables[a]
                s[sp - 1] = znInterpolate(s[sp - 1], t.ins, t.outs, t.ex)
            default: sp = Self.apply(ops[i], s, sp)
            }
        }
        return s[0]
    }

    // Kotlin's (Java's) min / max / sign: NaN in gives NaN out.
    private static func jmin(_ x: Float, _ y: Float) -> Float { x.isNaN || y.isNaN ? .nan : (x <= y ? x : y) }
    private static func jmax(_ x: Float, _ y: Float) -> Float { x.isNaN || y.isNaN ? .nan : (x >= y ? x : y) }

    /// Applies [op] to the top of the stack; returns the new stack size. No closures or boxing: this runs per frame.
    private static func apply(_ op: Int32, _ s: UnsafeMutablePointer<Float>, _ sp: Int) -> Int {
        let top = sp - 1
        switch op {
        case NEG: s[top] = -s[top]; return sp
        case NOT: s[top] = s[top] == 0 ? 1 : 0; return sp
        case ABS: s[top] = abs(s[top]); return sp
        case FLOOR: s[top] = s[top].rounded(.down); return sp
        case CEIL: s[top] = s[top].rounded(.up); return sp
        // JS Math.round: halves go up (-2.5 → -2).
        case ROUND: s[top] = (s[top] + 0.5).rounded(.down); return sp
        case SIGN: let x = s[top]; s[top] = x.isNaN ? .nan : x > 0 ? 1 : x < 0 ? -1 : x; return sp
        case SQRT: s[top] = s[top].squareRoot(); return sp
        case SIN: s[top] = sin(s[top]); return sp
        case COS: s[top] = cos(s[top]); return sp
        case TAN: s[top] = tan(s[top]); return sp
        case EXP: s[top] = exp(s[top]); return sp
        case LOG: s[top] = log(s[top]); return sp
        case COND: s[sp - 3] = s[sp - 3] != 0 ? s[sp - 2] : s[sp - 1]; return sp - 2
        case CLAMP:
            let lo = jmin(s[sp - 2], s[sp - 1]), hi = jmax(s[sp - 2], s[sp - 1])
            let x = s[sp - 3]
            s[sp - 3] = x < lo ? lo : x > hi ? hi : x
            return sp - 2
        default: break
        }
        // Two values: x (below) and y (on top).
        let x = s[sp - 2], y = s[sp - 1]
        let r: Float
        switch op {
        case ADD: r = x + y
        case SUB: r = x - y
        case MUL: r = x * y
        case DIV: r = y == 0 ? 0 : x / y
        case MOD: r = y == 0 ? 0 : x.truncatingRemainder(dividingBy: y)
        case LT: r = x < y ? 1 : 0
        case GT: r = x > y ? 1 : 0
        case LE: r = x <= y ? 1 : 0
        case GE: r = x >= y ? 1 : 0
        case EQ: r = x == y ? 1 : 0
        case NE: r = x != y ? 1 : 0
        // JS's && and || give one of the two values, not true / false.
        case AND: r = x != 0 ? y : x
        case OR: r = x != 0 ? x : y
        case MIN: r = jmin(x, y)
        case MAX: r = jmax(x, y)
        case POW: r = pow(x, y)
        case ATAN2: r = atan2(x, y)
        case HYPOT: r = hypot(x, y)
        default: r = x
        }
        s[sp - 2] = r
        return sp - 1
    }

    /// Checks and builds a formula. [code]: the tokens; [inputs]: what "$k" reads; [tables]: for "L<k>" / "C<k>",
    /// each [[ins], [outs], ex, isColour] (outs are ARGB numbers for "C"). Throws ZnInvalidArgs with the reason.
    static func compile(_ code: [Any], _ inputs: [ZnFormulaInput], _ tables: [Any]?) throws -> ZnFormula {
        let n = code.count
        if n == 0 { throw ZnInvalidArgs("formula is empty") }
        if n > maxOps { throw ZnInvalidArgs("formula has \(n) steps; at most \(maxOps)") }
        var parsed: [Table] = []
        for (i, raw) in (tables ?? []).enumerated() {
            let t = raw as? [Any] ?? []
            let ins = znJsonFloats(t.first)
            let outsRaw = t.count > 1 ? t[1] as? [Any] ?? [] : []
            if ins.count < 2 || outsRaw.count != ins.count {
                throw ZnInvalidArgs("interpolate table \(i) needs 2+ inputs and as many outputs")
            }
            for k in 1..<ins.count where ins[k] < ins[k - 1] {
                throw ZnInvalidArgs("interpolate table \(i): inputs must go up")
            }
            let isColor = t.count > 3 && Int(znJsonNumber(t[3]) ?? 0) == 1
            let ex = t.count > 2 ? Int(znJsonNumber(t[2]) ?? 0) : 0
            parsed.append(Table(ins: ins, outs: isColor ? [] : znJsonFloats(outsRaw),
                                colors: isColor ? outsRaw.map(znArgb) : nil, ex: ex))
        }
        var ops = [Int32](repeating: 0, count: n), args = [Int32](repeating: 0, count: n)
        var consts: [Float] = []
        var depth = 0
        var usesSite = false, isColor = false
        func need(_ k: Int, _ what: String) throws {
            if depth < k { throw ZnInvalidArgs("formula step \"\(what)\" needs \(k) values, has \(depth)") }
        }
        for i in 0..<n {
            let tok = code[i]
            if isColor { throw ZnInvalidArgs("interpolateColor must be the last step of a formula") }
            if let num = znJsonNumber(tok) {
                let v = Float(num)
                if !v.isFinite { throw ZnInvalidArgs("formula constant is not finite") }
                ops[i] = CONST
                args[i] = Int32(consts.count)
                consts.append(v)
                depth += 1
            } else {
                guard let t = tok as? String else { throw ZnInvalidArgs("formula step \(i) is not a number or a name") }
                if t.hasPrefix("$") {
                    guard let k = Int(t.dropFirst()) else { throw ZnInvalidArgs("bad formula input \"\(t)\"") }
                    if !inputs.indices.contains(k) { throw ZnInvalidArgs("formula input \(k) doesn't exist") }
                    ops[i] = INPUT
                    args[i] = Int32(k)
                    if case .src(let s) = inputs[k], s.usesSite { usesSite = true }
                    depth += 1
                } else if t == "sw" || t == "sh" || t == "pw" || t == "ph" {
                    ops[i] = t == "sw" ? SELF_W : t == "sh" ? SELF_H : t == "pw" ? PARENT_W : PARENT_H
                    usesSite = true
                    depth += 1
                } else if t.hasPrefix("L") || t.hasPrefix("C") {
                    guard let k = Int(t.dropFirst()) else { throw ZnInvalidArgs("bad formula table \"\(t)\"") }
                    if !parsed.indices.contains(k) { throw ZnInvalidArgs("formula table \(k) doesn't exist") }
                    let color = t.first == "C"
                    if color != (parsed[k].colors != nil) {
                        throw ZnInvalidArgs("formula table \(k) is the wrong kind for \"\(t)\"")
                    }
                    try need(1, t)
                    ops[i] = color ? COLOR_TABLE : TABLE
                    args[i] = Int32(k)
                    if color { isColor = true }
                } else {
                    guard let (op, arity) = names[t] else { throw ZnInvalidArgs("formula can't use \"\(t)\"") }
                    try need(arity, t)
                    ops[i] = op
                    depth = depth - arity + 1
                }
            }
            if depth > maxStack { throw ZnInvalidArgs("formula needs more than \(maxStack) values at once") }
        }
        if depth != 1 { throw ZnInvalidArgs("formula leaves \(depth) values; it must leave 1") }
        return ZnFormula(ops: ops, args: args, consts: consts, inputs: inputs, tables: parsed, isColor: isColor,
                         usesSite: usesSite)
    }
}
