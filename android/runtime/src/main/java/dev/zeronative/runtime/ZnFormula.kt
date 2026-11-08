package dev.zeronative.runtime

import org.json.JSONArray
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sign
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * A `derive(() => ...)` formula (docs/gestures-and-motion-v1.md §2.4, D1): the compiler turns the TS expression into
 * postfix tokens (compiler motion.ts); this checks them once when JS makes the formula and runs them in the draw phase
 * on a fixed stack, with no allocation.
 *
 * Tokens: a number (a constant), "$k" (input k: a source or a constant JS passed), "sw" "sh" "pw" "ph" (the site's
 * own / parent width and height), an operator or function name (OPS), "L<k>" (interpolate with table k),
 * "C<k>" (interpolateColor with table k: only as the last token; the formula is then a colour).
 *
 * Limits (checked here, and by the compiler first): at most [MAX_OPS] tokens, a stack of at most [MAX_STACK] that
 * never runs short, one value at the end, known inputs only. Inputs exist before the formula, so there are no cycles.
 * x / 0 and x % 0 are 0. A result that isn't finite is dropped by the source (its last good value stays).
 */
internal class ZnFormula private constructor(
    private val ops: IntArray,
    private val args: IntArray,
    private val consts: FloatArray,
    private val inputs: Array<Input>,
    private val tables: Array<Table>,
    val isColor: Boolean,
    val usesSite: Boolean,
) {
    sealed class Input {
        class Const(val v: Float) : Input()
        class Src(val s: ZnSource) : Input()
    }

    /** An interpolate table: inputs, outputs (numbers, or ARGB colours as floats' bits), extrapolation. */
    class Table(val ins: FloatArray, val outs: FloatArray, val colors: IntArray?, val ex: Int)

    private val stack = FloatArray(MAX_STACK)

    fun eval(site: ZnSite?): Float {
        if (isColor) return 0f
        return run(site)
    }

    fun evalColor(site: ZnSite?): Int {
        if (!isColor) return 0
        // The last op is the colour table: run everything before it, then mix.
        val x = run(site, ops.size - 1)
        val t = tables[args[ops.size - 1]]
        return znMixColors(x, t.ins, t.colors!!)
    }

    private fun run(site: ZnSite?, end: Int = ops.size): Float {
        val s = stack
        var sp = 0
        for (i in 0 until end) {
            val a = args[i]
            when (ops[i]) {
                CONST -> s[sp++] = consts[a]
                INPUT -> s[sp++] = when (val inp = inputs[a]) {
                    is Input.Const -> inp.v
                    is Input.Src -> inp.s.read(site)
                }
                SELF_W -> s[sp++] = site?.selfW?.floatValue ?: 0f
                SELF_H -> s[sp++] = site?.selfH?.floatValue ?: 0f
                PARENT_W -> s[sp++] = site?.parentW?.floatValue ?: 0f
                PARENT_H -> s[sp++] = site?.parentH?.floatValue ?: 0f
                TABLE -> {
                    val t = tables[a]
                    s[sp - 1] = znInterpolate(s[sp - 1], t.ins, t.outs, t.ex)
                }
                else -> sp = apply(ops[i], s, sp)
            }
        }
        return s[0]
    }

    companion object {
        const val MAX_OPS = 64
        const val MAX_STACK = 16

        private const val CONST = 0
        private const val INPUT = 1
        private const val SELF_W = 2
        private const val SELF_H = 3
        private const val PARENT_W = 4
        private const val PARENT_H = 5
        private const val TABLE = 6
        private const val COLOR_TABLE = 7

        private const val ADD = 10
        private const val SUB = 11
        private const val MUL = 12
        private const val DIV = 13
        private const val MOD = 14
        private const val NEG = 15
        private const val LT = 16
        private const val GT = 17
        private const val LE = 18
        private const val GE = 19
        private const val EQ = 20
        private const val NE = 21
        private const val AND = 22
        private const val OR = 23
        private const val NOT = 24
        private const val COND = 25
        private const val MIN = 26
        private const val MAX = 27
        private const val ABS = 28
        private const val FLOOR = 29
        private const val CEIL = 30
        private const val ROUND = 31
        private const val SIGN = 32
        private const val SQRT = 33
        private const val POW = 34
        private const val SIN = 35
        private const val COS = 36
        private const val TAN = 37
        private const val ATAN2 = 38
        private const val HYPOT = 39
        private const val EXP = 40
        private const val LOG = 41
        private const val CLAMP = 42

        /** Operator name → (opcode, values it takes). */
        private val OPS: Map<String, Pair<Int, Int>> = mapOf(
            "+" to (ADD to 2),
            "-" to (SUB to 2),
            "*" to (MUL to 2),
            "/" to (DIV to 2),
            "%" to (MOD to 2),
            "neg" to (NEG to 1),
            "<" to (LT to 2),
            ">" to (GT to 2),
            "<=" to (LE to 2),
            ">=" to (GE to 2),
            "==" to (EQ to 2),
            "!=" to (NE to 2),
            "&&" to (AND to 2),
            "||" to (OR to 2),
            "!" to (NOT to 1),
            "?" to (COND to 3),
            "min" to (MIN to 2),
            "max" to (MAX to 2),
            "abs" to (ABS to 1),
            "floor" to (FLOOR to 1),
            "ceil" to (CEIL to 1),
            "round" to (ROUND to 1),
            "sign" to (SIGN to 1),
            "sqrt" to (SQRT to 1),
            "pow" to (POW to 2),
            "sin" to (SIN to 1),
            "cos" to (COS to 1),
            "tan" to (TAN to 1),
            "atan2" to (ATAN2 to 2),
            "hypot" to (HYPOT to 2),
            "exp" to (EXP to 1),
            "log" to (LOG to 1),
            "clamp" to (CLAMP to 3),
        )

        /**
         * Applies opcode [op] to the top of the stack; returns the new stack size. No lambdas or boxing: this runs
         * per frame for every bound formula.
         */
        private fun apply(op: Int, s: FloatArray, sp: Int): Int {
            when (op) {
                NEG -> { s[sp - 1] = -s[sp - 1]; return sp }
                NOT -> { s[sp - 1] = if (s[sp - 1] == 0f) 1f else 0f; return sp }
                ABS -> { s[sp - 1] = abs(s[sp - 1]); return sp }
                FLOOR -> { s[sp - 1] = floor(s[sp - 1]); return sp }
                CEIL -> { s[sp - 1] = ceil(s[sp - 1]); return sp }
                // JS Math.round: halves go up (-2.5 → -2), unlike Kotlin's round-half-even.
                ROUND -> { s[sp - 1] = floor(s[sp - 1] + 0.5f); return sp }
                SIGN -> { s[sp - 1] = sign(s[sp - 1]); return sp }
                SQRT -> { s[sp - 1] = sqrt(s[sp - 1]); return sp }
                SIN -> { s[sp - 1] = sin(s[sp - 1]); return sp }
                COS -> { s[sp - 1] = cos(s[sp - 1]); return sp }
                TAN -> { s[sp - 1] = tan(s[sp - 1]); return sp }
                EXP -> { s[sp - 1] = exp(s[sp - 1]); return sp }
                LOG -> { s[sp - 1] = ln(s[sp - 1]); return sp }
                COND -> { s[sp - 3] = if (s[sp - 3] != 0f) s[sp - 2] else s[sp - 1]; return sp - 2 }
                CLAMP -> {
                    val lo = minOf(s[sp - 2], s[sp - 1])
                    val hi = maxOf(s[sp - 2], s[sp - 1])
                    s[sp - 3] = s[sp - 3].coerceIn(lo, hi)
                    return sp - 2
                }
            }
            // Two values: x (below) and y (on top).
            val x = s[sp - 2]
            val y = s[sp - 1]
            s[sp - 2] = when (op) {
                ADD -> x + y
                SUB -> x - y
                MUL -> x * y
                DIV -> if (y == 0f) 0f else x / y
                MOD -> if (y == 0f) 0f else x % y
                LT -> if (x < y) 1f else 0f
                GT -> if (x > y) 1f else 0f
                LE -> if (x <= y) 1f else 0f
                GE -> if (x >= y) 1f else 0f
                EQ -> if (x == y) 1f else 0f
                NE -> if (x != y) 1f else 0f
                // JS's && and || give one of the two values, not true / false.
                AND -> if (x != 0f) y else x
                OR -> if (x != 0f) x else y
                MIN -> minOf(x, y)
                MAX -> maxOf(x, y)
                POW -> x.pow(y)
                ATAN2 -> atan2(x, y)
                HYPOT -> hypot(x, y)
                else -> x
            }
            return sp - 1
        }

        /**
         * Checks and builds a formula. [code]: the tokens; [inputs]: what "$k" reads; [tables]: for "L<k>" /
         * "C<k>", each [[ins], [outs], ex] (outs are ARGB numbers for "C"). Throws ZnInvalidArgs with the reason.
         */
        fun compile(code: JSONArray, inputs: Array<Input>, tables: JSONArray?): ZnFormula {
            val n = code.length()
            if (n == 0) throw ZnInvalidArgs("formula is empty")
            if (n > MAX_OPS) throw ZnInvalidArgs("formula has $n steps; at most $MAX_OPS")
            val parsedTables = Array(tables?.length() ?: 0) { i ->
                val t = tables!!.getJSONArray(i)
                val ins = ZnMotion.floats(t.optJSONArray(0))
                val outsRaw = t.optJSONArray(1) ?: JSONArray()
                if (ins.size < 2 || outsRaw.length() != ins.size) throw ZnInvalidArgs("interpolate table $i needs 2+ inputs and as many outputs")
                for (k in 1 until ins.size) if (ins[k] < ins[k - 1]) throw ZnInvalidArgs("interpolate table $i: inputs must go up")
                val isColor = t.optInt(3, 0) == 1
                val colors = if (isColor) IntArray(ins.size) { outsRaw.optLong(it).toInt() } else null
                Table(ins, if (isColor) FloatArray(0) else ZnMotion.floats(outsRaw), colors, t.optInt(2, 0))
            }
            val ops = IntArray(n)
            val args = IntArray(n)
            val consts = ArrayList<Float>()
            var depth = 0
            var usesSite = false
            var isColor = false
            fun need(k: Int, what: String) {
                if (depth < k) throw ZnInvalidArgs("formula step \"$what\" needs $k values, has $depth")
            }
            for (i in 0 until n) {
                val tok = code.get(i)
                if (isColor) throw ZnInvalidArgs("interpolateColor must be the last step of a formula")
                if (tok is Number) {
                    val v = tok.toFloat()
                    if (!v.isFinite()) throw ZnInvalidArgs("formula constant is not finite")
                    ops[i] = CONST
                    args[i] = consts.size
                    consts += v
                    depth++
                } else {
                    val t = tok as? String ?: throw ZnInvalidArgs("formula step $i is not a number or a name")
                    when {
                        t.startsWith("$") -> {
                            val k = t.substring(1).toIntOrNull() ?: throw ZnInvalidArgs("bad formula input \"$t\"")
                            if (k !in inputs.indices) throw ZnInvalidArgs("formula input $k doesn't exist")
                            ops[i] = INPUT
                            args[i] = k
                            if ((inputs[k] as? Input.Src)?.s?.usesSite == true) usesSite = true
                            depth++
                        }
                        t == "sw" || t == "sh" || t == "pw" || t == "ph" -> {
                            ops[i] = when (t) { "sw" -> SELF_W; "sh" -> SELF_H; "pw" -> PARENT_W; else -> PARENT_H }
                            usesSite = true
                            depth++
                        }
                        t.startsWith("L") || t.startsWith("C") -> {
                            val k = t.substring(1).toIntOrNull() ?: throw ZnInvalidArgs("bad formula table \"$t\"")
                            if (k !in parsedTables.indices) throw ZnInvalidArgs("formula table $k doesn't exist")
                            val color = t[0] == 'C'
                            if (color != (parsedTables[k].colors != null)) throw ZnInvalidArgs("formula table $k is the wrong kind for \"$t\"")
                            need(1, t)
                            ops[i] = if (color) COLOR_TABLE else TABLE
                            args[i] = k
                            if (color) isColor = true
                        }
                        else -> {
                            val (op, arity) = OPS[t] ?: throw ZnInvalidArgs("formula can't use \"$t\"")
                            need(arity, t)
                            ops[i] = op
                            depth = depth - arity + 1
                        }
                    }
                }
                if (depth > MAX_STACK) throw ZnInvalidArgs("formula needs more than $MAX_STACK values at once")
            }
            if (depth != 1) throw ZnInvalidArgs("formula leaves $depth values; it must leave 1")
            return ZnFormula(ops, args, consts.toFloatArray(), inputs, parsedTables, isColor, usesSite)
        }
    }
}
